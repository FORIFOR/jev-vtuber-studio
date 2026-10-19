// Viewer-facing copy comes only from observed programme/connection state.
// No audience counts, names, fabricated votes, or promises of game control.
export function participationView(s = {}, now = Date.now()) {
    if (!s.running || s.panic) return { visible: false, welcome: '', detail: '', question: '', context: '' };
    const selected = s.streamTarget || '';
    const yt = selected !== 'twitch' && ['connected', 'listening', 'polling_degraded'].includes(s.youtube);
    const tw = selected !== 'youtube' && s.twitch === 'connected';
    const closing = ['closing', 'closed'].includes(s.topic?.stage);
    const ready = !s.commentsPaused && !closing && (yt || tw);
    const partial = selected === 'simulcast' && ready && !(yt && tw);
    const v = s.gameShow?.external ? s[s.gameShow.statusKey] : null;
    let context = 'いまは、のんびり雑談中';
    if (v) {
        if (v.phase === 'lobby') context = 'いまは雑談中 · このあとゲームへ';
        else if (v.phase === 'playing') {
            // Today's goal from the settings (GAME_GOAL); the old fixed text only without one.
            context = typeof s.gameShow?.goal === 'string' && s.gameShow.goal.trim() ? `目標：${s.gameShow.goal.trim()}` : '目標：80レベルを超える';
        } else if (['results', 'intermission', 'between'].includes(v.phase)) context = 'いまはプレイを振り返って、ひと休み';
        else if (v.phase === 'done') context = '今夜の挑戦を振り返っています';
        else context = 'ゲームの準備中';
    } else if (s.blocks) context = '目標：落ち物パズルで自己ベストに挑戦';
    else if (s.game) context = 'いまは星集めパズルで遊んでいます';
    if (closing) context = '今夜の配信を振り返っています';
    const prompt = v?.participation;
    const question = ready && prompt && typeof prompt.text === 'string' &&
        Number.isFinite(prompt.startedAt) && prompt.startedAt <= now && Number.isFinite(prompt.expiresAt) && prompt.expiresAt > now
        ? prompt.text : '';
    return {
        visible: true,
        welcome: ready ? '💬 チャットでゲームに参加してノアを助けてね！' : '見るだけでもどうぞ 🌙',
        detail: !ready ? 'コメントへの反応は、いまお休みしています'
            : partial ? '一部でコメントへの反応がお休み中です · 返信は不要です'
            : '「草」「R / L」「数字」だけでも大歓迎 · 挨拶・返信は不要です',
        question, context
    };
}

export function participationRows(p) {
    if (!p) return [];
    return ['youtube', 'twitch'].map(platform => {
        const v = p[platform] || {}, latency = v.responseLatencyMs;
        const count = value => Number.isFinite(value) ? value.toLocaleString('ja-JP') : '—';
        const seconds = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)}秒` : '未測定';
        return { platform: platform === 'youtube' ? 'YouTube' : 'Twitch',
            received: count(v.received), approved: count(v.approved), replied: count(v.replied),
            participants: `${count(v.uniqueParticipants)}${v.uniqueParticipantsIsLowerBound ? '以上' : ''}`,
            latency: latency ? `中央値 ${seconds(latency.p50)} / 95%点 ${seconds(latency.p95)} (${count(latency.samples)}件)` : '未測定' };
    });
}
