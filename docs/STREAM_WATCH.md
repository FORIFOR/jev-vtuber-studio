# Stream watch (optional)

Off by default. When enabled, the Studio checks a running show every few minutes and keeps a log; an AI agent
(Claude Code or Codex, already installed and logged in on this Mac) reviews each check. It never controls the show.

## Enable (data/settings.json or .env)

| key | values | default |
|---|---|---|
| `STREAM_WATCH` | `off`, `claude`, `codex` | `off` |
| `STREAM_WATCH_MINUTES` | 5–60 | 10 |
| `STREAM_WATCH_MAX_PER_DAY` | agent calls per day | 48 |
| `STREAM_WATCH_MODEL` | agent model (Claude: `haiku`; Codex: a model this CLI supports) | Claude `haiku` / Codex its default |
| `STREAM_WATCH_MAX_USD` | Claude `--max-budget-usd` per call (API-key billing) | 0.05 |

Restart the Studio after changing them.

## Each check

1. The Studio collects a small snapshot itself (no AI): show phase, comment reception, OBS output (active,
   reconnecting, skipped frames), game runner, the current run (time, level), memory, and a few counters with their
   change since the last check (lines spoken, refused lines, comment replies).
2. Plain flags need no AI: OBS output stopped, no line spoken for the whole interval, the game clock not moving, the
   runner failed, comment reception in error, memory warning.
3. The agent gets only that snapshot (no files, no tools: Claude `--tools ""`, Codex `--sandbox read-only`), at low
   CPU priority, with a 120 s timeout, one check at a time. It is skipped under memory pressure and past the daily cap.
   It answers `{"status":"ok|warn|alert","summary","issues","improvements"}`; it is told not to suggest loosening any
   safety or gate threshold.
4. One JSON line per check goes to `data/stream-watch/YYYY-MM-DD.jsonl` (at most 5 MB per day). Flags and issues also
   reach the operator page as a notice.
