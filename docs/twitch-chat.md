# Twitch read-only chat

The local application uses a public Twitch client with Device Code authorization and only `user:read:chat`. It does not send Twitch messages or start OBS.

1. Register a public Chat Bot client at Twitch Developer Console, redirect `http://localhost:8787`.
2. Run `TWITCH_CLIENT_ID=<public ID> node scripts/twitch-auth.mjs start`.
3. Open the returned activation link on your phone or browser. Approve the intended `hoshiai_noa` account.
4. Run `node scripts/twitch-auth.mjs complete`. The script validates identity and scope, then writes ignored, mode-0600 credentials under `data/twitch/oauth.json`.
5. Set `TWITCH_ENABLED=true` in `.env` and restart Studio. In live mode, chat intake starts/stops with the programme; demo mode never connects.

Tokens are validated on each connection and at least every 45 minutes. Refresh-token rotation is persisted atomically. Expired or revoked authorization requires repeating the device flow. Never commit or share the credential file. The client ID is public.

Incoming messages retain source `twitch`, pass the normal privacy/injection checks and author cooldown, and are deduplicated. Old messages are discarded. Twitch status appears next to YouTube status in Studio.

Connection subscription was verified against Twitch on 2026-09-30. Actual viewer comment reception and audible playback still need an operator test. No public stream was started. Simultaneous output configuration in OBS/Restream is separate; keep combined cross-platform chat overlays out of the Twitch output.

## Studio destination selector

In Studio → Output, select YouTube only, Twitch only, or simulcast and press the switch button while the programme, recording and stream are stopped. This switches the existing OBS profiles (`無題` for YouTube, `星藍ノア - Twitch` for Twitch), verifies the service and presence of a key, and persists `STREAM_TARGET` in local settings. Simulcast uses a separately configured Restream OBS profile and reads both platforms' chats; combined cross-platform chat overlays are hidden. Single-destination mode reads only that platform's chat. Keys are never returned to the browser.

Before OBS starts, its current profile and service are checked again; a mismatch prevents transmission. Profile switching rejects active streams, recordings and replay buffers. A failed switch restores the previous profile. Remote start approval is invalidated after a switch. The existing voice rehearsal and OBS-audio checks remain required.
