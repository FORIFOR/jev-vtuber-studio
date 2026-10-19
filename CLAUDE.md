# Jev VTuber Studio

Local-first AI VTuber streaming studio. Node >=22.12, ESM (`.mjs`), zero npm dependencies — do not add any without asking.

## Verify before claiming done
- `npm test` runs all `test/*.test.mjs` (node:test). Focused: `npm run test:programme`, `test:comment-reply`, `test:remote`, `test:regression`.
- `npm run release:check` (check + full tests) before reporting a multi-file change complete.
- `npm run demo` for an offline runtime smoke: demo mode never calls the judge or external APIs (rule-based stand-ins in `src/jev.mjs`).

## Output gate (src/jev.mjs, local judge)
- No remote Jev API (operator decision 2026-10-09): `Jev.ask()` answers the gate's typed questions with the local LLM (`src/local-judge.mjs`; `JUDGE_MODEL` / `JUDGE_BASE_URL`, default = the conversation model). The class keeps its name.
- Every broadcast utterance passes `Jev.speech()`; viewer comments pass `Jev.chat()`. Both run a local PII/injection check first, then score typed questions against numeric thresholds. Exception (operator 2026-10-19): while a person has Noa's voice (`src/control.mjs`, `docs/CONTROL.md`) their own speech is not gated; every generated line still is, and nothing is generated meanwhile.
- Fail closed: a judge failure (timeout, bad JSON, missing key, Ollama down) throws and the line is not aired; an unjudged comment is neither answered nor read aloud. There is no bypass or regex-only mode in live.
- In talk programmes, `novel` and `progress` must both be >= .7 (openings exempt). Speech `injection` must be < .2 (calibrated on the remote Jev, 2026-09-26, not yet re-calibrated for the local judge; the comment gate stays < .15). Game lines (`game_reaction` / `game_commentary` / `game_fact`, see `TalkEngine.utterance`) are judged on `fits` (the observed game state) and `apt` (or `answers` for facts) >= .7 instead of novel/progress; game facts come from the adapter, never the model. A rejection throws `Output gate rejected speech`.
- `rehearse()` in `src/settings.mjs` = generate → local judge → TTS WAV (→ VOICEVOX comment voice). Live talk start requires a passing rehearsal the operator confirmed hearing.
- When speech fails the gate, fix what the generator produces (prompts/context in `src/providers.mjs`, `src/talk-engine.mjs`) rather than loosening thresholds or adding blind retries. If a workaround is unavoidable, say so explicitly.

## Constraints
- Local services may be offline (Ollama :11434, VOICEVOX :50021, OBS WS :4455); tests must not require them — inject `fetchFn` / overrides as existing tests do.
- Secrets live in `.env` and `data/` (gitignored). Never print their values or commit them.
- `docs/RC*_FIXES.md` and `docs/RC4_CHANGES.md` are historical release notes, not the current spec. Current design: `docs/ARCHITECTURE.md`, `docs/PROGRAMME.md`.
- `scratch/` is throwaway; ignore it when searching.
