# Architecture / invariants — 0.2.0-rc.6

*Updated 2026-10-18. `docs/RC*_FIXES.md` and `docs/RC4_CHANGES.md` are past release notes, not this spec.*

## Boundaries

`server.mjs` owns loopback HTTP, configuration, explicit trial consent and separate admin/view capabilities. `TalkEngine` owns the programme and sound queue; a single `Director` owns topic revision/return state. I/O is asynchronous, not multiple independent agents with competing state. A game programme adds a show (`external-game-show.mjs` and the game's own subclass, e.g. `vampire-show.mjs`) that the TalkEngine asks for lines; the game itself runs outside the Studio (see Games below). Search is optional and off unless configured.

The conversation provider generates a complete short utterance. The output gate (`jev.mjs`; the class keeps the name of the former remote Jev service) approves the utterance before either its audio or its displayed subtitles are published. Since 2026-10-09 the gate's typed questions are answered by the local LLM (`local-judge.mjs`, `JUDGE_MODEL` / `JUDGE_BASE_URL`, default the conversation model); there is no remote judge. A judge failure (timeout, bad JSON, missing key, Ollama down) throws and the line is not aired; an unjudged comment is neither answered nor read aloud. There is no bypass in live. TTS is serialized per `Voice` instance and cached in memory; a prepared turn may contain at most two parts, and only one speculative next turn is allowed. This is application-level overlap, not unreviewed token streaming.

## Cancellation and memory

A generation job carries a session epoch, generation serial, topic revision and AbortController. Abort is advisory at the remote provider; returned stale results are also checked and discarded. Cancellation does not guarantee a refund or stopped provider computation.

Normal chat does not cut the current spoken sentence. A selected comment invalidates an autonomous next-turn draft. Explicit next-topic and closing also invalidate speculation. Renderer expiration/error cancels queued audio. A full turn is committed to programme state only after all its parts finish; each heard part is recorded independently in bounded memory. Unheard speculation is never committed as something the audience heard.

Memory compaction decisions are applied to original record IDs in the current collection, not by replacing the collection with an old snapshot. The talk Director does not require metered compaction to continue; short memory is sufficient for its current bounded contract.

## Failure handling

Generation retry state (`generationFailures`, `generationRetryAt`) is independent of media timing (`nextTurnAt`) and incomplete-playback failures (`turnFailures`). A first-stage generation/approval/TTS failure uses 2s/4s/8s/max10s backoff, shared by ordinary and speculative preparation; four generation failures stop the show. Success in preparing an approved first audio part resets generation failures. Playback ACKs cannot clear generation backoff. Four consecutive later-part failures also stop the show; a wholly played turn clears only that playback failure count.

Speculative work is launched without awaiting it in the sender. Cancelled preparation retains its lock until its provider promise settles; stale results are rejected by epoch/serial/revision and cannot affect a new session. An initial generation is awaited only when there is no current audio to deliver. The provider's existing request timeout bounds an uncooperative network request.

Selected comments hold an explicit bounded reservation. Cancelling unpublished work restores an eligible reservation at the head of the reply queue (no second input judgement), or records a terminal drop reason (expired/session/closing/stop). Already published replies are never automatically replayed after uncertain delivery. First publication checks TTL again; continuation parts are allowed to finish even if TTL expires while speaking. Reservations, prepared replies and current replies all count toward the paid-admission limit.

Closing begins shortly before the session deadline and produces a reviewed ending. A hard time limit may interrupt that ending if dependencies are too slow. `finish` is graceful; `stop`/panic cancel immediately within the live local runtime. Already-delivered YouTube buffers cannot be retracted.

A person can take Noa's voice mid-show and hand it back (`src/control.mjs`, `docs/CONTROL.md`): while `control.voice` is `human` no turn is prepared, judged or voiced and the person's own speech is not gated (operator decision 2026-10-19); the AI voice and the person's OBS mic are never open together, and stop/panic/start always return the voice to the AI with the mic muted. `control.listening` `muted` shows comments in the chat box without taking them up. A voice-call partner (`docs/COLLAB.md`) is heard through the capture page `/collab` and the local whisper.cpp server (`src/stt.mjs`); their words get the local PII/injection check and Noa's `collab_reply` passes the full gate with the comment-reply questions; `src/collab.mjs` holds the floor while they speak and lets them barge in. How the person behind Noa is heard is `HUMAN_VOICE_MODE` (`docs/HUMAN_VOICE.md`): `resynth` keeps the OBS mic muted and speaks their transcribed words (local PII/injection check, no gate) in Noa's own TTS voice, and the AI's first line afterwards receives what they said. Handoffs (Phase 4) run one at a time; the AI voice fades out over 120 ms on the stage; while the AI does not have the voice (`human` or `none`) its first line is prepared in a pause of the person and gated as always, used only while fresh, else a pre-gated bridge line airs; the latency from the press to silence and to the AI's first line is recorded. The Live Control Panel (`/control`, Phase 6) and hotkeys act through the same `/api/control`; a hotkey is resolved by the server on the current state, from the Studio, the panel or `scripts/global-hotkeys.mjs` (Carbon hotkeys); a manual avatar face holds over every automatic reaction.

A separate optional supervisor retains the previous conservative OBS ownership design. There is no guarantee of stopping broadcast when the PC, network, watchdog or OBS itself is unresponsive.

## Input and spending

Local eligibility (PII and injection checks), deduplication, queue capacity and TTL limits precede the judge. Selected reply queue capacity gates classification so judgement requests do not grow proportionally to a flood while speech is blocked. Daily requests and returned provider token counts are bounded/persisted, but are not a dollar budget. The provider can omit usage and may bill failed or cancelled requests.

## Settings

Schema is whitelisted; scalar types and URL schemes are validated. Stored secrets never return in settings GET. A blank secret field preserves it; deletion is explicit. Atomic file replacement with restrictive Unix mode is used, not encryption. API/voice/character changes invalidate real trial/hearing confirmation. YouTube/OBS settings alone do not invalidate unchanged voice trials.

The setup real trial has no external broadcast side effects. Public broadcast is a separate allow flag plus explicit start action, a running live engine, renderer lease, and completed WAV playback. That is a software guard, not independent proof of audible output or policy compliance.

## Voice pipeline

Host speech keeps the `voice.synthesize(text, signal)` seam; the only addition is an optional third argument, the part's delivery plan. With the defaults (`SPEECH_DIRECTION=off`, `REACTION_AUDIO=false`, `PHRASE_CACHE=false`) and provider VOICEVOX or Supertonic 3, `DirectedVoice.passThrough()` delegates to the unchanged `ReplyVoice`: same HTTP calls, cache and gate request. Operator guide, tables and engine notes: [VOICE.md](VOICE.md).

```
generate → Jev.speech, the local gate (+ delivery questions only in 'jev' mode, same request)
  → SpeechDirector.plan (pure: exact substrings, deliveries, pauses, ≤1 clip, beats)
  → DirectedVoice / VoiceQualityRouter: CACHE (exact phrase take) → LOCAL (one engine) → PREMIUM (null, disabled)
  → audio bus: one PCM16 mono WAV per part, assembled with the planned clip
  → finalize at publication (post-cooldown reaction: keep or drop the clip, leadMs, beats, mouth) → stage
```

Invariants:
- A turn still has at most 2 parts and 220 characters; the ACK protocol, `/audio`, the 8 s start deadline, `lastAudioOK` and `obsProof` are unchanged.
- Direction never alters approved text: chunks must concatenate to the approved part (`PLAN_INVARIANT` is thrown before any engine call). Cached phrases replace only an exact normalized chunk or part rendered by the same voice identity and render key; clips are operator-attested wordless files.
- One WAV per part. `engine.audio` still holds at most 1 entry; one speculative turn.
- The part is assembled with its planned clip, so its duration is an upper bound for `maxTurnAudioMs`; `finalize()` can only keep or drop that clip, so audio only shrinks at publication. A clip over the part's `budgetMs` is dropped at assembly. Part 0's budget reserves part 1's estimated speech plus its planned pauses and tail; because that is still an estimate, part 0's clip length (`clipMs`) is exempt from the later parts' `maxTurnAudioMs` check, so a clip never fails a turn mid-air. The rehearsal audition reel plays every mapped style plus the base style unmapped families fall back to, at broadcast levels (clips via `conditionClip` with their `gainDb`, style renders as the bus produced them). A credit-required SBV2 model (amitaro/koharune) needs `SBV2_CREDIT` at rehearsal in every profile and again at local and remote start; its presence is part of the check fingerprint.
- One `tts` ledger reservation per voiced part (a part with at least one engine call); cache-only parts reserve nothing. Engine calls are per-engine concurrency-1 queues, enqueued atomically per part (part 0 ≤ 2 calls, others ≤ 3).
- No voice fallback. A local failure rejects the part; a per-engine circuit breaker (2 DOWN/MISMATCH → 15 s open, doubling to 60 s) makes `TalkEngine.prepare` skip the LLM and gate calls while open.
- Delivery answers in 'jev' mode are validated outside the gate and can never accept, reject, throw or count a gate failure. Gate questions and thresholds are unchanged.
- `checkFingerprint` covers every audio-affecting key (provider URLs/styles/speeds, `HOST_STYLE_MAP`, `SPEECH_DIRECTION`, `REACTION_AUDIO`, `PHRASE_CACHE`) and the voice library hash. Credit strings stay out. The library loads only at startup, rehearsal and explicit setup reload, never mid-show.

## Code map

| File | Role |
|---|---|
| `settings.mjs` / `public/setup.*` | Guided setup, masking, metadata and real trial |
| `talk-engine.mjs` / `director.mjs` | Topic persistence, replies, closing, speculative speech |
| `providers.mjs` | LLM and sentence WAV synthesis/cache |
| `jev.mjs` / `local-judge.mjs` | Output gate: local PII/injection check, typed questions answered by the local LLM, numeric thresholds, fail closed |
| `llm-route.mjs` | Optional bigger model on another machine (`LLM_REMOTE_URL`), used only while it answers; otherwise the local model |
| `youtube.mjs` / `youtube-stream.mjs` | Reconnect state and optional gRPC |
| `metrics.mjs` / `store.mjs` | Bounded metrics, usage, playback memory |
| `public/avatar-rig.mjs` | Reaction presets, Affect, AvatarController (idle / reflex / lip sync) and Cubism→VTS mapping, shared by stage, engine and VTS bridge. See `docs/AVATAR.md` |
| `speech-director.mjs` | Pure acting direction for approved text: chunks, deliveries, pauses, clip plan, beats; Jev delivery questions and `readDelivery` thresholds |
| `public/voice-acting.mjs` | VOICE_ACTING (preset → voice family/intensity/pace/clip), NONVERBAL classes, ClipGovernor, `voiceLead`, INTENSITY_GAIN; shared by Node and the stage |
| `voice-router.mjs` | DirectedVoice (host voice seam, pass-through, audition reel) and VoiceQualityRouter (tiers, queues, circuit, warm-up, ledger, finalize) |
| `tts-adapters.mjs` | VOICEVOX, AivisSpeech, Style-Bert-VITS2 and Supertonic 3 adapters: identity, delivery → params, health/identity checks |
| `audio-bus.mjs` / `wav.mjs` | Zero-dependency PCM: one canonical WAV per part, exact pauses, clip placement, rehearsal part join and reel |
| `reaction-audio.mjs` | Operator voice library under `data/voice/`: wordless clips, exact-text phrase takes, allowlist, fingerprint |
| `voice-bench.mjs` | Same-sentence blind A/B benchmark helpers (`npm run voice:bench`) |
| `obs.mjs` / `vts.mjs` | OBS ownership and optional Live2D bridge (VTube Studio parameter frames) |
| `games.mjs` / `game-runner.mjs` / `run-log-feed.mjs` | Game plug-ins (`games/<id>/game.json`), the controller started and stopped with the show, and the read-only follower of its per-run log |
| `external-game-show.mjs` / `vampire-show.mjs` / `blocks-show.mjs` | Game shows: rounds, events, lines, commentary and answers from observed state only |
| `affect-engine.mjs` | Noa's accumulated mood from game events and comments (faces and tone, never facts) |
| `twitch.mjs` | Optional Twitch chat in, alongside YouTube |
| `memory-guard.mjs` / `disk-guard.mjs` | Read-only memory pressure and disk headroom checks before and during a show |
| `stream-watch.mjs` | Optional watch (`STREAM_WATCH`): a status snapshot (counts and states, no comment text) reviewed by a local agent CLI |
| `youtube-schedule.mjs` | Reserved broadcast creation and binding (`youtube.force-ssl` consent); never starts or ends a broadcast |
| `post-stream.mjs` / `clip-studio.mjs` | After a show: clips, Shorts and thumbnails from the logs and OBS's recording; upload only with `CLIP_UPLOAD=1` |

## Games

A game is a plug-in folder `games/<id>/` (`docs/GAMES.md`). Its controller is a separate program (Vampire Survivors: `jev-vampire-survivors`, whose bridge reads the game and whose agent picks one of rule-built candidate actions, either through the remote Jev API or a local deterministic ranking with `NOA_LOCAL_CHOOSER=1`). The controller writes one JSON observation per line; the Studio only reads that log. Game facts spoken by Noa come from it, never from the model, and game lines are judged on `fits` and `apt` (or `answers`) instead of `novel`/`progress`. A game whose `player` is `operator` (Smash) has no controller: the streamer plays and Noa comments on reported events.

Runtime isolation is architectural, not OS-level sandboxing. Do not run untrusted plugin code in-process or expose the server directly on a public interface.
