# rc.3 implementation map and verification contract

## Changed boundary

The full local server remains on 127.0.0.1:8787. `src/remote-server.mjs` is a separate opt-in server bound to 127.0.0.1:8788. A trusted Tailscale Serve instance terminates TLS and supplies user identity. This is NOT a generic public reverse proxy or an internet-facing admin server.

| File | Responsibility |
|---|---|
| src/remote-server.mjs | exact Host/Origin, Serve user allowlist, secure cookie, CSRF, request-size/action limits, asset and endpoint allowlist |
| src/remote-control.mjs | local arming receipt, verified OBS source/destination, bounded idempotency, cancellation generation, observed start/stop |
| src/server.mjs | local arm/disarm routes; integrates rehearsal and OBS-only WAV proof; keeps remote and admin servers separate |
| src/obs.mjs | adds ephemeral OBS-renderer identity to dedicated source URL |
| public/stage.mjs | sends OBS renderer identity only on local renderer claim |
| public/mobile.* | status and start/stop/panic only; no audio renderer or offline action queue |
| public/setup.* | PC-only consent and eight-hour arming panel |
| scripts/remote-setup.mjs | explicit local configuration; never alters firewall, launches shell from web, or publishes a stream |
| test/remote*.test.mjs | control, authorization, actual loopback HTTP and CLI tests |

## Start protocol

Local rehearsal + local heard confirmation + a valid OBS-owned WAV end acknowledgment + human recording/destination confirmation produce an in-memory arming receipt for 8 hours. A digest binds settings and a canonicalized OBS service/source description. Raw stream-service data never goes to the phone. Config changes, reboot and panic revoke authorization. The arming callback is only reachable through the existing private local admin API.

A start requires a new operation UUID, the exact configured video ID, and an explicit `START_BROADCAST` confirmation. Processing is asynchronous in the server, but requested synchronously by the user's action. It returns HTTP202 and a job ID. The server rechecks conditions, starts its own OBS stream, observes active/non-reconnecting output, and starts the local talk engine. It does not claim YouTube public availability. Runtime lives on the PC, independent of phone page lifecycle.

The stop generation is advanced before slow operations are awaited. Late starts are cleaned up. StopStream acknowledgment is not itself considered a verified stop: own output is polled for termination; if it stays active or becomes unobservable the result is stop_unconfirmed. Existing unowned OBS streams are not stopped. The existing OBS class serializes its RPC mutations and keeps intent ownership in the private data directory.

## Scope limits

The desktop is trusted. Local processes can spoof a reverse-proxy identity header. No Windows/macOS/Linux service installer, Wake-on-LAN, arbitrary video playback, auto-created YouTube event, dynamic cloud GPU provisioning, persistent off-host job queue, OAuth broker or public multi-tenant service is implemented. Eight-hour permissions and 12-hour cookies live only in process memory. No promise of an exact-once side effect across process crashes is made.

The phone's idempotency map stores latest128 operation IDs in the current process. The mobile browser does not automatically replay failed actions. Status requests are read-only. Payloads and sessions are bounded. Keys remain on the host in existing private storage (not encrypted by this feature).

## Test contracts

Assertions distinguish local unit/control behavior from actual external integration. Tests use dummy source keys, mock OBS RPCs and synthesized silent WAV buffers. The HTTP flow test uses the real main server, real rehearsal HTTP pipeline against local fixture services, actual renderer ACK routes and the real mobile gateway. It does not bypass the rehearsal flags by injecting booleans. Separate unit tests inject control callbacks to explore cancellation, output changes, network failure and idempotency.

The HTTP fixture simulates a trusted Serve header at loopback. It is not a real Tailscale network, TLS handshake, Safari cookie validation or OBS audio recording. Browser navigation was attempted normally and blocked by administrator policy; no workaround was used. User-specific remote networking, actual service credentials, public livestreaming and GitHub push were not performed.
