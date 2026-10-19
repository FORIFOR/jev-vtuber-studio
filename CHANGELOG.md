# 0.2.0-rc.3

- Added opt-in, loopback-only mobile gateway intended exclusively for private Tailscale Serve HTTPS with a named-user allowlist.
- Added secure session/CSRF enforcement, restricted actions, bounded idempotency and no offline action replay.
- Added PC-only eight-hour arming after real rehearsal, OBS-specific WAV ACK and explicit recording/destination confirmation.
- Added start preflight for the OBS scene, source, visibility, mute, volume and hashed stream destination.
- Added start/stop cancellation handling, late-start cleanup, observed stop confirmation and panic revocation.
- Added phone-specific UI, home-screen manifest and local setup instructions. No mobile rendering/secret distribution.
- Added 21 tests (140 total): control/HTTP/CLI plus integrated local rehearsal-to-remote start/stop with fixture services.
- Existing rc.2 six regression fixes retained. External Tailscale/iPhone/OBS/YouTube verification remains unperformed.

# Changelog

## Unreleased

### Added
- NOA Studio (2026-10-19): one Noa shared by the AI and a person; every switch works mid-show.
  - **Phase 1:** a voice handoff between the AI and a person through an OBS mic input, with listening muted/comments (`src/control.mjs`).
  - **Phase 2:** a Discord partner is heard through the capture page `/collab`, transcribed by local whisper.cpp, and answered as a gated `collab_reply`. Includes turn-taking and barge-in (`src/collab.mjs`, `src/stt.mjs`).
  - **Phase 3:** a person can speak in Noa's own TTS voice (`HUMAN_VOICE_MODE=resynth`). `scripts/kohaku-dataset.mjs` prepares RVC training audio.
  - **Phase 4:** instant handoff. Switches are serialized and the AI fades out over 120 ms. The resume line is prepared while the person speaks, with a bridge line as fallback. Adds MUTE NOA / AI RESUME and handoff latency.
  - **Phase 5:** the game's controls are handed to a person and back. The controller acknowledges each epoch, input is gated before every send, and the game is observed while a person plays.
  - **Phase 6:** the Live Control Panel `/control`, configurable hotkeys plus `npm run hotkeys` for any app (Carbon), and a manual avatar face.
- Gemini 3.8 Flash TTS / Flash-Lite TTS as an opt-in, paid, single host voice (`gemini-tts` / `gemini-lite-tts`): style via `speech_metadata`, wordless reactions as whitelisted inline vocal tags in the same voice when no recorded clip exists, per-run spend cap `GEMINI_TTS_MAX_USD`, cost estimate in the Studio, `--allow-cloud` required for benchmark and prerender.

## 0.2.0-rc.6 — Voice (directed host voice, avatar reaction rig, viewer/Studio split)

### Added
- SpeechDirector (`src/speech-director.mjs`): splits approved speech into exact substrings and maps the Jev `reaction` preset (VOICE_ACTING in `public/voice-acting.mjs`) to per-chunk voice family, intensity, pace, pauses, at most one wordless clip per turn and mid-part avatar beats. Optional `jev` mode adds delivery questions to the same Jev.speech request, validated outside the gate.
- VoiceQualityRouter + DirectedVoice (`src/voice-router.mjs`): CACHE (exact phrase takes) → LOCAL (one engine) → PREMIUM (disabled slot); per-engine queues, circuit breaker, warm-up, one ledger reservation per voiced part, publication-time clip finalize and a rehearsal expression reel. No voice fallback.
- ReactionAudioCache (`src/reaction-audio.mjs`): operator-supplied wordless clips and allowlisted phrase takes under `data/voice/`, allowlist `config/phrases.json`, loaded at startup/rehearsal/explicit reload only; its fingerprint joins the rehearsal check.
- Local engine adapters (`src/tts-adapters.mjs`) and audio core (`src/wav.mjs`, `src/audio-bus.mjs`): VOICEVOX, AivisSpeech (:10101), Style-Bert-VITS2 (:5055) and Supertonic 3; one PCM16 WAV per part.
- Avatar/stage sync: intensity gain, `leadMs = 0` with a pre-clip, mid-part beats and mouth windows; Studio VOICE and DELIVERY cards; new latency metrics.
- New npm scripts: `npm run voice:library` (prerender / import-clip / import-phrase / verify / list / remove), `npm run voice:bench` (same-sentence blind A/B benchmark) and `npm run test:voice`.
- Docs: `docs/VOICE.md`.
- Viewer/Studio split: `/stage` shows only the avatar, subtitles, the game (when on) and a picked comment for a few seconds; programme/phase/latency moved to the Studio monitor (`GET /api/monitor`, admin only: AI state, reaction, comment queue, performance, game brain, events).
- Avatar reaction rig (`public/avatar-rig.mjs`): Jev picks one named preset; code turns it into Live2D Cubism parameters (idle blink/breath/sway/gaze, listen → reflex → speak → afterglow, lip sync). Drives the built-in SVG and, via `POST /api/renderer/avatar`, VTube Studio (custom Jev* inputs). Docs: `docs/AVATAR.md`.
- Instant wordless reflex: a Jev-accepted comment (glance) or a game star (cheer) moves the face at once, never while speaking.
- `MAX_REACTION_AUDIO_MS` (default 1200): reaction sounds have their own budget on top of `MAX_TURN_AUDIO_MS`; the absolute turn ceiling is their sum.
- Benchmark: 9 categories (normal 8; happy/surprise/embarrassed/serious; short reaction/question/fast game/long, 4 each), five 1–5 scales plus "two hours: Y/N" (ranks first), and a Voice Consistency Test whose any identity break excludes the voice.
- Engine burn-in at show start (3 unaired, uncached sentences): measured on VOICEVOX, short-sentence TTFA p95 1645 → 528 ms.
- Consultation programme with an idle game that pauses for comments (game-mode programme work carried in this release).

### Security
- `scripts/live-player.mjs` reads ADMIN_TOKEN / VIEW_TOKEN from the environment or `.env`; no hard-coded tokens.
- `__pycache__/`, `*.pyc` and `.claude/` are ignored; the tracked `.pyc` is removed from the index.

### Not in this release
- Jev decision-boundary calibration (argmax tolerance, question wording, opening exemption, loosened thresholds) is held back for rc.7 and will be evaluated on a record/replay corpus.

### Defaults
- `SPEECH_DIRECTION=off`, `REACTION_AUDIO=false`, `PHRASE_CACHE=false`, `REPLY_TTS_PROVIDER=voicevox`: host speech, Jev requests and fixtures behave exactly as before. Measure with `npm run voice:bench` before enabling. Jev gate questions and thresholds are unchanged.

## 0.2.0-rc.2

### Fixed
- R01: detach single-flight speculative preparation from ready-audio delivery; cancelled jobs retain their lock until settlement.
- R02: generation failure counter/deadline no longer shares playback timing or resets on an unrelated playback ACK.
- R03: explicit ownership through selected → reserved → prepared → published → playing → completed. Unplayed cancelled replies are requeued exactly once when eligible; other discards have reasons.
- R04: recheck comment TTL and session before first publication, without cutting an already published answer halfway through.
- R05: normalize CRLF/CR in personas, allow LF/tab, keep bounded length/control-character rejection, and show field-specific UI validation.
- R06: include .gitignore/.npmignore in both source ZIP and tgz, validate a private-file denylist before packaging, and test archives with dummy secrets.

### Validation
- 119 tests pass (99 prior + 20 regression/HTTP/packaging tests). The first six new regression tests were all red on the unchanged rc.1 source and green after fixes.
- Real 200ms worker with a deliberately unresolved 3-second generation still delivers ready audio; real retry loop waits at least 2 seconds. These are simulated providers, not live API benchmarks.
- Application keys, real AI voice quality, gRPC/YouTube/OBS E2E, other OS execution and long live broadcasts remain unverified.

## 0.2.0-rc.1

### Added
- Japanese guided connection UI: redacted secrets, explicit deletion, character settings, model/voice detection, real metered trial and hearing gate.
- Talk-only default with topic cards, persistence, replies/return state, opening and closing, next-topic and comment pause controls.
- Approved sentence-sized TTS, overlap with playback, bounded one-turn prefetch and cancellation; native Ollama no-thinking requests.
- YouTube API-key path, waiting-for-live/reconnect/duplicate/history handling, optional official gRPC adapter and visibly degraded polling fallback.
- Returned token usage, bounded p50/p95 metrics, opt-in real provider rehearsal benchmark.
- Node-based launch helpers, English README, contributor/security docs, issue/PR templates and local distribution packaging.

### Fixed
- YouTube watcher no longer permanently exits simply because a broadcast has not started.
- Reply capacity is checked before paid classification, instead of judging every queued comment then discarding it.
- Concurrent memory appends survive older compaction results.
- Metadata-only discovery cannot be used as successful real speech rehearsal.
- Later sentence failures remain counted despite successful earlier sentence playback.

### Validation
- 99 automated tests pass, including real local HTTP transport with simulated providers and a 300-turn deterministic playback simulation.
- Guided setup/studio isolated DOM smoke test passes with actual loopback HTTP/SSE bridge.
- Actual service credentials, gRPC package install/wire connection, native full-browser E2E, OBS/YouTube broadcast, human listening, hardware latency and other OS execution are unverified.

## 0.1.0

Initial developer preview with Jev/LLM/voice adapters, legacy game/research prototype, renderer ownership and explicit OBS controls. It did not implement the later talk-only specification or beginner setup flow.
