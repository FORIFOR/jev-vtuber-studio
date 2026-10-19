# Noa Studio and broadcast layout: review candidate

Base: `fix/live-issues-20261006` at `9e483e21a5614efef109ce62a7787d00dfc638aa`.

This is a draft implementation. It has not been applied to an OBS installation, streamed, merged, or visually signed off.

## Changes

- Studio uses a navy/white control-room palette and separates Live, Ads, and Preparation. The live surface keeps programme controls, comments, host state, and monitoring together. Advertising drafts and output setup move out of the live workspace.
- A paused preview explains why it is blank. Preview-only Talk/Game/Portrait selection changes only the iframe and stage link. It does not switch OBS scenes or start/stop a show. Entering Ads or Preparation unloads the iframe, preserving the existing memory-saving default.
- The game capture remains exactly **1120×630 at (48,120)** on the existing 1920×1080 output. No capture migration is required. The avatar viewport sits at **(1250,328), width 560**, below the 480×270 advertising creative. The game browser source keeps that geometry even in opening talk or stopped state, because the browser cannot know whether OBS has hidden its separate capture.
- The existing chat/command sources remain **556×175 at (48,772)/(612,772)**. Chat no longer moves across the avatar during opening talk. The commands still hide during opening talk. Latest chat rows are bottom-anchored so new messages do not disappear below the clipped viewport.
- Game subtitles occupy the safe area below the chat/action band, bounded to two lines. Bilingual subtitles use one Japanese and one English line. Source links reduce the main caption to one line when needed. Long text is visually ellipsized; this does not alter spoken text or the saved transcript.
- The brief decision HUD shows only the accepted input, below the current goal and above the capture. It hides the competing run/player badge while visible. Its decision validation, two-second expiry and eight-second combat interval are unchanged. The integrated five-row operation log is removed from Stage; separate OBS sources are unchanged.
- Advertising remains 16:9 with recruitment/paid disclosure. Text-only recruitment uses a quieter navy background; uploaded image/video creative colors are unchanged. There are no fabricated sponsors or buttons.
- Vampire uses its actual survival personal best, or a first-record goal only when the record is explicitly absent. Other games use their title and phase instead of survival units. Same-round confirmed Vampire results show survival time and a verified record update. The unsupported “manager sleeping” label is removed.

## References inspected

The current Noa visual-reference sheet, the supplied starry-night room, and the OBS screenshot dated 2026-10-08 20.12.04 were opened and inspected. The reference sheet is a multi-panel concept sheet, and the night room contains baked-in labels and panels. Neither has been inserted wholesale into the live scene, where those baked-in UI elements would compete with dynamic captions and ads. Existing room and avatar assets are preserved; no replacement image set was generated.

## Verification

- `node scripts/check.mjs`: syntax check passed (240 modules before adding the new test; rerun on the final candidate includes 241).
- `node --test test/broadcast-layout.test.mjs test/decision-view.test.mjs`: **15/15 passed**. These include a mocked DOM execution test for preview selection/pause and source-contract tests for layout geometry. They are not pixel-rendering tests.
- Existing OBS-focused tests: **3/4 passed**. The remaining comment-delivery test fails identically on the unmodified baseline.
- Existing participation-view tests: **2/3 passed**, improved from **1/3** on the baseline. The actual-record goal test now passes; the invitation-copy assertion is an existing mismatch.
- `npm run release:check` was attempted. The syntax stage passed; the aggregate tests encountered numerous baseline failures and stalled. It was interrupted after approximately five minutes. This is **not** a full-suite pass.
- `git diff --check`: passed.

### Initial visual QA limitations (2026-10-08)

No rendered screenshots are claimed. The local demo started, but installed Chromium could not launch because the executor denies Unix sockets; the supported escalated retry had the same failure. The available cloud browser could not reach the isolated demo server. Both registered user Macs were offline, with no saved coding environment available.

Required review when a connected executor is available:

1. Open Studio at 1920px, 1280px, and 390px widths. Check all three workspaces for horizontal overflow, readable labels, and keyboard focus.
2. Open and pause the preview repeatedly. Cycle Auto/Talk/Game/Portrait, switch workspace, reconnect events, then verify pause remains honoured and no OBS control request was sent.
3. Render the current 2D and 3D models in Talk and Game at 1920×1080 and 1280×720; also render Portrait at a 390×844 viewport. Check long Japanese captions, bilingual captions, picked comments, recruitment and paid/image ads, and live decision expiry.
4. In an **inactive duplicate OBS scene**, verify the actual capture, chat/action browser sources, and avatar together. Cover playing, opening talk, game-over, stopped, reconnect, and restart. Do not change a live scene, stream/record state, audio routing, or source names during this review.
5. Capture and review real before/after screenshots before calling the candidate visually approved.

## Mac follow-up and layout corrections (2026-10-09)

The browser review found three regressions in PR #7 at `22cfd290ed12a4dc457e2842c4ff8578fdfa0b71`. CSS correction commit `7a10f794e9263a11525728641942cb9d14b0afce` addresses them:

- Reset the legacy comment column span/order at the new tablet breakpoint. Otherwise, at 851–1280px, PROGRAM was placed in the fixed 250px comment track instead of the remaining space.
- Share one bounded metadata row between the comment speaker label and source links. Keep Japanese and English on their own rows and reduce vertical padding when metadata is present. The caption remains within the original 98px safe band, without cutting a line through its glyphs.
- Reduce the integrated action log's line-height to fit its title and all five rows within the existing 175px box. The latest action is no longer clipped at the bottom.

### Actual browser observations

Chrome on the user's Mac rendered the checked-out assets with synthetic local SSE/API fixtures, no audio, no external API requests, and no OBS connection. CSS iframe widths were controlled independently from the window's display scaling.

- Saved and visually inspected Studio screenshots at **390, 850, 851, 900, 1280, 1281, 1500, 1501 and 1920px**. PROGRAM uses the flexible track above 850px and the first full-width row at/below 850px. The original 1280px regression is fixed.
- Saved and visually inspected long Japanese comment subtitles, source-linked subtitles, host bilingual subtitles, and all five integrated action rows at 1920/1280px. The Japanese comment's second line is complete; long text still ellipsizes intentionally.
- Browser geometry measurements also passed for **comment name + Japanese + English + source link simultaneously**: the caption box was 89.6px high, inside the 98px band; all children fit; the action log's scrollHeight equals its clientHeight. The Mac locked before this additional screenshot could be captured, so this combination has measured evidence, not an inspected screenshot.
- Earlier comparison confirmed separate game/avatar regions, clearly marked 16:9 advertising, game/lobby geometry, and preview-only Talk/Portrait/workspace switching. These source controls and capture geometry are unchanged by the correction.

Screenshots and measurements remain in the Mac task's `evidence/fix-20261009/` folder. Library's prescribed save route was unavailable; no Library file ID is claimed, and no alternative upload route was used.

### Isolated combination and tests

PR #6 `37dd2f99b1dc63d3161880f4fcd37759a1c3916f` was applied only in a detached local validation copy after the CSS correction, producing `1b6d2f416305bb0b3a46afd134f12dc4281f1ad5`. It is not part of the PR #7 branch and was not pushed or merged.

| Revision | Syntax | Focused tests | Broad diagnostic run |
|---|---:|---:|---|
| CSS correction `7a10f794` | 241 modules pass | layout/decision 15/15 | 920 pass / 33 fail / 7 skip |
| Local PR6+PR7 `1b6d2f41` | 242 modules pass | 146/146 (freshness-related 131 + layout/decision 15) | 936 pass / 33 fail / 7 skip |

The same 33 failures reproduce on the original PR #7 head. One extra baseline packaging failure caused by missing npm path metadata passed when its two tests were rerun with the correct environment. No new failing test was found from the CSS fix or local combination.

**This is not a passing `release:check`.** The standard command stalled on existing `memory-hold` / `smash-game` retained processing. The diagnostic comparison used a 20-second watchdog on each test-file child process and the same two files still required termination. Seven skips cover four external Python tests and three model-version-specific checks. Tests used injected providers, synthetic audio bytes/ACKs, and a guard that permits only test-owned loopback servers; real OBS/TTS/paid APIs were not contacted.

The Mac locked before an additional combined-version browser screenshot. Combined engine behavior is covered by the 146 focused tests; actual combined OBS composition and audible playback remain unverified.

### Existing issues kept outside this fix

- Portrait 2D clipping: the unchanged, later `body.layers .avatar` rule wins over `body.vertical .avatar`, placing the nominal right edge at1260 on a1080 canvas. Both baseline and PR #7 reproduce it.
- **Corrected observation — white 3D face/eyes/hair:** the earlier baseline and PR #7 screenshots were produced by a QA fixture that blocked embedded texture requests. This was a validation-environment error, not evidence of a model/product defect. The same model and renderer display colored hair, eyes and face with the product's existing CSP. See the controlled comparison below; no avatar or product rendering change is required.
- Independent overlay delivery: the clients request `/overlay/chat-events` and `/overlay/action-events`, but corresponding handlers are absent from the actual application server. Authenticated synthetic GETs returned404. The separate overlay script uses different paths. A fixture-backed screenshot does not establish real event delivery.

OBS was observed with stream/record timers at00:00:00 and the capture showing `No Signal`. No scene, source, audio routing or production process was changed, and no recording was made. Real game capture/OBS composition, actual speech timing, reconnect longevity and image/video advertisements remain for a separate isolated rehearsal. The unresolved avatar-write approval was not retried or bypassed. A rejected Safari private-tab restoration was not retried.

## Viewer focus follow-up (2026-10-09)

The saved talk/game screenshots showed that permanent participation instructions, an operation history and the bright recruitment card competed with Noa. This follow-up reduces that competition without changing the avatar, OBS sources or capture coordinates:

- Talk shows the actual current topic and a brief welcome. While a picked comment is visible, the welcome yields to it; an active, already-aired question may remain. The existing `actions=external` source still hides the invitation entirely.
- Game keeps the actual goal visible while a short “AIの選択” card names only the accepted input. Candidate probabilities, pre-input HP and the integrated operation history are omitted. No inferred intent, successful action or win is presented.
- Results require the current round ID, a confirmed `game_over`, and a positive finite observed time. A record claim also requires consistent previous-best/new-best fields. Other games and unknown values stay neutral.
- Text-only recruitment is less bright while retaining the labeled 16:9 slot. The subtitle safe bands and Studio width fix are unchanged.

At the first implementation checkpoint the Mac was locked, so that checkpoint did not include rendered after-change screens. The subsequent unlocked-Mac comparison is recorded below. Actual game capture is still needed to judge the complete composition. The white 3D observation was subsequently traced to the QA fixture's CSP, as documented below; no avatar-write approval was retried.

Validation of the final viewer changes: 58/58 focused cases passed across participation, decision, effects, broadcast layout and sponsor rendering. Syntax passed for 241 modules; the two subsequently corrected player-enum files passed final syntax checks. The guarded `release:check` diagnostic reported 930 pass / 32 fail / 7 skip, with no new failing names versus the prior 33-failure baseline. One obsolete invitation-copy failure was replaced with separate behavior checks. The player-enum correction occurred during the broad run and was covered by the final focused rerun; the broad run is not an exact-final-source full-suite pass. The same two retained test processes needed the existing watchdog.

The four user-specified Library references were requested on this Mac through the prescribed materialization route, but each download was denied. No local image bytes were created and no alternative route was attempted. They were not used as newly inspected visual evidence. The requested reference comparison remains incomplete; the subsequent local before/after capture is recorded below.

## Unlocked Mac before/after review (2026-10-09)

Chrome rendered immutable pre-viewer assets at `fd5adca887161b6e62d1271c13239c75a2a6b610` and the final implementation at `54a82da4c1a363f53a6353432c4887293c9b9c7c` in separate loopback-only fixture servers. These servers import no application backend, disable audio, reject production mutations, and use synthetic events. OBS is not connected to them. The Mac was unlocked and UI control worked; the earlier lock limitation no longer applies.

The actual comparison found and corrected a functional Studio defect: changing only the preview URL fragment did not reload Stage, so selecting Game after Talk left the talk composition visible. The preview now puts layout in the query string while retaining the token in the fragment. In the same open Studio, Talk, Game and Portrait produced their corresponding document classes. Changing selection while paused kept `about:blank` and the pause placeholder. The talk welcome also moved down 20px, leaving a 23px gap below the tested two-line topic.

### What was actually seen

- **Visual composition:** the 2D talk face is clear and central; the darker recruitment slot competes less with it. Topic and welcome have visible separation. Picking a comment hides the routine welcome. This improves composition but does not establish top-tier character performance or entertainment quality.
- **Game and text readability:** the game placeholder and avatar remain separate. The goal and accepted-input card are readable together above the capture. The confirmed synthetic result reads `2分17秒生存 · 自己ベスト更新`. The active question and picked comment fit without the previous question clipping. The integrated operation history no longer crowds the stage.
- **Long text:** an actual 1280px game screenshot covered comment-role Japanese + English + source metadata and a long picked comment together. Caption children fit in the reserved band and the glyph rows are complete. Long text is intentionally ellipsized; it is not fully displayed. Paid and recruitment ads retain explicit labels and 16:9 geometry.
- **Studio:** actual screenshots at 1280, 851 and 390px confirm flexible PROGRAM placement and no horizontal overflow. Same-window preview mode changes and paused-mode selection were exercised through the real controls.
- **3D observation, attribution corrected:** the earlier screenshot showed white face/eyes/hair despite ready state because the QA fixture blocked embedded textures. The controlled comparison below restored the colors in both the diagnostic view and Stage without changing the model, renderer or lighting. The earlier characterization as an existing product/model defect is withdrawn; this does not establish overall avatar-performance quality.

Local evidence is in `evidence/viewer-20261009/` in the Mac task, including `actual-ui-checks.json`, measurements and before/after screenshots. A second reviewer independently inspected the talk, picked-comment, game-decision and result comparisons. The requested Library routes remain unavailable/denied; no retry or alternate transfer was attempted, no images were delivered, and no new Library file IDs exist.

### Exact implementation validation and limits

At `54a82da4c1a363f53a6353432c4887293c9b9c7c`, all 59 focused cases and syntax checks for 241 modules passed. The guarded release diagnostic reported **931 pass / 32 fail / 7 skip**, with the same 32 failure names as the preceding viewer run. Source trees stayed unchanged throughout. The same two existing retained test processes required the watchdog, so **release:check remains failing**. Test counts support code behavior only; they are not evidence of visual appeal, voice quality or entertainment value.

PR #6 is unchanged at `37dd2f99b1dc63d3161880f4fcd37759a1c3916f`. Its earlier 131 focused freshness checks and the 146-case isolated PR6+CSS combination remain the available integration evidence; that combination does not contain the latest viewer changes.

The game area contains a labeled placeholder, not live game video. OBS was observed stopped with No Signal, and no scene/source/audio settings were changed. Real capture composition, physical speech interruption and duplicate playback, expression/voice/game-reaction integration, long reconnects and image/video creatives remain unverified. Existing Portrait 2D clipping and independent overlay-event 404s remain outside this change. This work is a draft visual/functional improvement, not a production or top-VTuber-quality sign-off.

## Correction: white 3D was caused by the QA fixture (2026-10-09)

The previous attribution to an existing 3D/model defect was incorrect. The temporary Mac QA servers used `connect-src 'self'`, while the product already uses `connect-src 'self' blob:` in `src/server.mjs`. GLTFLoader turns embedded PNGs into blob URLs; ImageBitmapLoader fetches those URLs. The QA policy blocked those fetches. The loader caught the failures and left texture maps unset, while the avatar still reached `ready=true`. Face, iris and hair materials have white factors and depend on these maps; solid-color navy clothing could therefore remain colored.

Chrome on the same Mac rendered a controlled A/B using identical model, bundle, camera, material factors and lighting. Only the QA `connect-src` blob allowance differed:

| Observation | Old QA policy: self only | Product-equivalent policy: self + blob |
| --- | ---: | ---: |
| Rejected embedded-image fetches / texture-load errors | 14 | 0 |
| Runtime materials with a color map (including outlines) | 0 | 32 |
| Runtime material count / model version | 129 / 4.92.0 | 129 / 4.92.0 |
| Avatar ready | true | true |
| Actual appearance | White hair, eyes and face | Dark hair, golden eyes and face color restored |

The corrected condition loaded the face, hair and iris as 1254×1254 ImageBitmaps in sRGB. The same colors were then verified in the actual Stage page. An independent reviewer inspected both A/B images and runtime records. Lighting remained hemisphere 0.85, key 2.0 and rim 1.1; renderer output remained sRGB, tone mapping 0 and exposure 1. These findings identify the missing QA blob allowance as the cause of this observed white appearance, without attributing it to lighting, shader compatibility or broken model textures.

Model SHA-256: `4bc7d25e0cb0d218fcc6b8eb4db8becb5ab43fe54c754adfccc0eb229443e2ef`. Shipped renderer-bundle SHA-256: `7d1850a5858d19e4c5d004471ae49d73db693a6365718e5ece9d3036f1bc1fc0`. Both match the user's original checkout; neither changed during the comparison.

The fix was applied **only to temporary, untracked QA files in the Mac task workspace**: `qa-server.mjs` and `qa-viewer-server.mjs`. The separate `qa-vrm-investigation.mjs` served the controlled comparison. None is part of this PR or the production repository. This PR correction changes documentation only; no model, shader, application CSP, avatar branch, OBS setting or production process was changed. No new avatar-write approval is required for the QA correction, and the outstanding separate approval was not retried or bypassed.

Local evidence: `evidence/white-investigation-20261009/runtime-self-only.json`, `runtime-blob-allowed.json`, `csp-self-only.jpg`, `csp-blob-allowed.jpg` and `stage-correct-csp.jpg`. Earlier white screenshots remain historical records of the faulty QA condition and must not be used to claim a product/model defect. Library delivery remains unavailable; no new file ID is claimed.

No Signal is a separate unresolved input issue: UGREEN is recognized by macOS/OBS without a relevant disconnect/format-error record, but the HDMI upstream cause is **not determined**. The separate Stage endpoint at port 8787 had no listener. This correction does not resolve or change either condition, and does not establish live capture, audible performance or top-VTuber-level quality.

## Isolated talk/audio rehearsal (2026-10-09)

Actual Mac Chrome exercised the application engine through `createApp` with fresh QA data, fixed conversation replies, demo configuration and injected OBS/game/provider stubs. Outbound fetch/socket/process operations were blocked. This was not a production `npm run demo` launch: that command alone does not isolate persisted settings or OBS. Neither live-player nor paid TTS was invoked.

- Chrome exposed nine local Japanese voices. Kyoko produced native start/boundary/end events with volume forced to zero. A synthetic comment appeared once, followed by the two reply sentences; immediate resubmission returned `duplicate`. This checks native speech control, not audible quality.
- The same harness compared Stage from `e1c80a7` with this fix. Before: the rejected utterance still reached native speak/start/end while its caption stayed empty. After: the rejected utterance never reached native speak; its error ACK cancelled that ID, and a later, separately accepted ID could proceed. Stage now awaits an accepted start ACK before browser speech or subtitle fallback and ignores obsolete callbacks/ACK completions.
- Five exact-text, hash-verified WAV parts were generated from the already installed Kyoko voice using file output only. Stage fetched and decoded them through its normal WAV/analyser/ACK path. A QA-only connection redirect sent audio to MediaStreamDestination instead of speakers. The comment card, reading subtitle, listening face, reply subtitle and moving mouth were visually inspected. The internal recording is 406,295 bytes; observed analyser RMS peaked at 0.1032, and forwarded mouth openness at 0.5876. Both returned to zero after Stop; no probe errors were recorded. No microphone or display capture was used.

Validation: 11/11 new regression cases and 31/31 directly related cases passed; syntax passed for 242 modules. The guarded release diagnostic reported **942 pass / 32 fail / 7 skip** (981 total). The same 32 failure names and two watchdog terminations reproduce the unchanged implementation baseline; no new failure was introduced. This is still not a green release check.

Evidence remains in the Mac task's `evidence/talk-demo-20261009/`, `evidence/talk-audio-20261009/` and `evidence/fix-20261009/tests/browser-speech-*`. The QA tab/server were closed; OBS retained stopped timers and muted microphone. The original checkout and avatar branch were untouched. No Library image was delivered or file ID created.

The controlled talk result supersedes the earlier lack of any expression/voice rehearsal only for this fixture. Speaker audibility, voice quality/pronunciation, live TTS/OBS routing, full PR6+latest-PR7 integration, game reactions and long reconnects remain unverified. Start ACK now precedes native OS onset, so captions may lead actual speech slightly; exact audible synchronization was not measured.
