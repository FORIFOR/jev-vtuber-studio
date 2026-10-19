import { createHmac, randomBytes } from 'node:crypto';
import { Metrics } from './metrics.mjs';

const SOURCES = ['youtube', 'twitch'];

/** Per-show aggregates only. Viewer identifiers never enter a snapshot or the show log. */
export class ParticipationMetrics {
    constructor({ mode = 'live', now = () => performance.now(), maxParticipants = 5000 } = {}) {
        this.mode = mode; this.now = now; this.maxParticipants = maxParticipants;
        this.salt = randomBytes(32); this.excludedLocalOrDemo = 0;
        this.sources = Object.fromEntries(SOURCES.map(source => [source, {
            received: 0, approved: 0, readStarted: 0, replied: 0,
            participants: new Set(), uniqueParticipantsIsLowerBound: false, latency: new Metrics()
        }]));
        this.finalSnapshot = null;
    }
    receive({ source, author }) {
        if (this.finalSnapshot) return null;
        if (this.mode !== 'live' || !SOURCES.includes(source)) { this.excludedLocalOrDemo++; return null; }
        const s = this.sources[source]; s.received++;
        if (typeof author === 'string' && author && author !== 'local') {
            const id = createHmac('sha256', this.salt).update(source).update('\0').update(author.slice(0, 200)).digest('hex');
            if (!s.participants.has(id)) {
                if (s.participants.size < this.maxParticipants) s.participants.add(id);
                else s.uniqueParticipantsIsLowerBound = true;
            }
        } else s.uniqueParticipantsIsLowerBound = true;
        // Kept on the internal candidate, never on a public event or persisted record.
        return { source, receivedMono: this.now(), approved: false, readStarted: false, replied: false };
    }
    approve(receipt) {
        if (!receipt || this.finalSnapshot || receipt.approved) return;
        receipt.approved = true; this.sources[receipt.source].approved++;
    }
    playbackStarted(receipt, role = 'host') {
        if (!receipt?.approved || this.finalSnapshot) return;
        const s = this.sources[receipt.source];
        if (role === 'comment') {
            if (!receipt.readStarted) { receipt.readStarted = true; s.readStarted++; }
        } else if (!receipt.replied) {
            receipt.replied = true; s.replied++;
            s.latency.record('response', this.now() - receipt.receivedMono);
        }
    }
    snapshot() {
        if (this.finalSnapshot) return structuredClone(this.finalSnapshot);
        return {
            scope: 'session', basis: 'received_to_local_playback_start',
            // Receivers do not currently classify broadcaster, staff or bots. Do not call these organic viewers.
            staffAndBotExclusion: 'unavailable', uniqueViewers: null, participationRate: null,
            returningParticipants: null, excludedLocalOrDemo: this.excludedLocalOrDemo,
            ...Object.fromEntries(SOURCES.map(source => {
                const s = this.sources[source];
                return [source, { received: s.received, approved: s.approved, readStarted: s.readStarted, replied: s.replied,
                    uniqueParticipants: s.participants.size, uniqueParticipantsIsLowerBound: s.uniqueParticipantsIsLowerBound,
                    responseLatencyMs: s.latency.snapshot().latency.response || null }];
            }))
        };
    }
    close() {
        if (this.finalSnapshot) return;
        this.finalSnapshot = this.snapshot();
        for (const s of Object.values(this.sources)) s.participants.clear();
        this.salt.fill(0);
    }
}
