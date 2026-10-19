# Opening conversation flow

The Vampire Survivors opening uses `config/lobby-scenes.json`: 12 scenes, each with
4–5 conversational beats. These are generation directions, not live scripts.
`demo` is used only in DEMO mode; a refused live line never falls back to it.

The previous deck cycled through independent preference/reason prompts with a
fixed two-sentence form. In one local programme's ten-minute lobby, all 34 completed
monologues had two sentences and 18 turns revisited a prior beat. These playback
records are not proof of delivery to a public streaming platform or retention.

## Behaviour

- Scene order is shuffled once per programme. Beat order inside a scene is fixed;
  a later beat develops the actual choice made earlier, not a prewritten answer.
- Short reactions, choices, descriptions and endings have different length targets.
  Planned lobby speech can contain 1–3 sentences, bounded to 110 characters and the
  existing total audio ceiling (18 seconds by default). Replies remain 1–2 sentences.
- Only a complete host turn with valid playback ACKs enters scene memory. The
  current scene retains at most 6 host turns; at most 12 completed scene summaries
  are retained. This memory resets with the programme.
- Viewer replies keep their own goal and do not advance the scene. They retain the
  existing input/output gates, quote permission, queue limits and budgets.
- There is at most one speculative generation. Scene boundaries wait for playback.
  A refused speculative beat skips its dependent scene only after its predecessor
  completes; cancelling the predecessor also cancels that deferred skip.
- An exhausted lobby deck leads into the game instead of wrapping. The usual lobby
  timer still applies. Unstarted expired lobby speech is discarded; an already
  started turn finishes. The existing game's timed lead-in is unchanged.

## Verification and limits

`test/lobby-flow.test.mjs` covers ACK ownership, partial/cancelled speech, comments,
speculative rejection races, deadlines, scene exhaustion and bounded history.
`test/lobby-generation.test.mjs` covers provider output bounds, unchanged Jev
safety/honesty thresholds and reserving audio time for all remaining sentences.
All providers in these tests are fakes; there are no paid calls or public posts.

On the next authorised rehearsal, judge the *actual* model output and audio: whether
the premise carries through, a comment is answered before returning, there are
short and long turns, and repeated introductions decrease. Compare completed
`speech` records by `beatId`, plus output refusals and dead-air measurements in
`show-log.jsonl`. Do not equate these automated tests with entertainment quality,
viewer-retention improvement, voice listening tests or three-hour stability.

No model, voice, video quality, advertisement schedule, memory protection or fee
limit is changed by this feature. It introduces no model service or background job.
