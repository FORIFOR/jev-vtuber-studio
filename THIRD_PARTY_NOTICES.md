# Third-party notices

The original Studio source, original SVG avatar, CSS/HTML and generated effect tone code are MIT. No font files, external audio recordings, machine-learning model weights or Live2D sample models are bundled. Bundled third-party JavaScript, the VRM model and motion assets are listed below.

The generated `public/noa-vrm-avatar.mjs` bundles **Three.js 0.186.1**, **@pixiv/three-vrm 3.5.5** (including its companion packages) and **@pixiv/three-vrm-animation 3.5.5**, all MIT. Their notices are preserved in `licenses/three-MIT.txt`, `licenses/three-vrm-MIT.txt` and `licenses/three-vrm-animation-MIT.txt`. The exact bundle and local input hashes are in `licenses/noa-vrm-build.json`; `scripts/build-vrm-avatar.mjs` reproduces it with esbuild 0.28.2. Runtime npm installation and CDN access are not needed.

`public/models/noa3d/Noa.vrm` is **Noa 4.86**, a customized VRoid Project (pixiv) AvatarSample_A, also used as an AIRI preset. **The avatar is not MIT or CC0.** Its separate terms and restrictions are linked in `public/models/noa3d/AVATAR-LICENSE.md`. Reference-illustration rights are separate; this source license does not establish them. No AIRI application source is bundled.

The six bundled VRMA clips originate in **Microsoft Rocketbox**, converted in the Hanami asset collection. Their exact source revisions and SHA-256 hashes are in `public/models/noa3d/motions/manifest.json`; preserve its `Microsoft-LICENSE.md` and `UPSTREAM-NOTICE.md`. No Hanami application code is included. The motion MIT license does not relicense the avatar.

`public/vendor/` contains two unmodified browser libraries used by the NOA BLOCKS stage game, served by exact filename only:
- **jQuery 3.7.1** (`jquery-3.7.1.min.js`), MIT, © OpenJS Foundation and other contributors — `public/vendor/LICENSE-jquery.txt`.
- **Blockrain.js 0.2.1** (`blockrain-0.2.1.jquery.js`, `blockrain-0.2.1.css`), MIT, © 2015 Aerolab — `public/vendor/LICENSE-blockrain.txt`.
Sources and SHA-256 hashes are in `public/vendor/README.md`. Studio's extensions live in `public/noa-blocks.mjs`. "NOA BLOCKS" is a generic falling-block puzzle; it is not Tetris and is not affiliated with The Tetris Company.

`public/models/noa/*.png` are part images of the Noa character, AI-generated artwork prepared for this project and supplied by the operator (Noa_Live2D_Prototype v0.1, `Source/layers`), repaired, extended with two mouth shapes derived from the same art, and cropped by `scripts/build-noa-layers.py`. They are project assets, not covered by a third-party character-model license, and are not relicensed as MIT code. The prototype's model writer / preview / tests are GPL-3.0-only and are deliberately **not** included; `public/layer-avatar.mjs` is an independent implementation that only positions these images.

`proto/stream_list.proto` is an adapted **minimal subset** of Google's published YouTube Streaming Live Chat Protocol Buffers definition. Fields unrelated to read-only text chat were removed. Original: https://developers.google.com/youtube/v3/live/streaming-live-chat . Google documentation code samples are Apache-2.0; see `licenses/Apache-2.0.txt`. The adaptation is not an endorsement or a complete Google client implementation.

Optional packages `@grpc/grpc-js` and `@grpc/proto-loader` are installed separately; their distributed license files and dependency notices govern those packages. They are not relicensed by this project.

Jev/TypeSafe, Google/Gemini/YouTube, Ollama, OBS, VOICEVOX and VTube Studio are independent projects/services. Names identify API compatibility or design inspiration and imply no affiliation. The project is not a fork of jev-telop-live and does not copy or relicense that repository's source/assets.

The public repository leaves out `public/models/noa3d/Noa.vrm`, the room pack under `public/models/room/` and the outfit preview renders, because their redistribution or origin is not confirmed. Operators who want them supply their own (docs/ASSETS.md). The entries above about these files describe the original private setup.

Tools and voices used by NOA Studio (docs/CONTROL.md, docs/COLLAB.md, docs/HUMAN_VOICE.md) are **not bundled**. Operators obtain each one themselves and follow its own licence:
- **whisper.cpp**: local speech to text (`whisper-server`), with a Whisper model such as `ggml-large-v3-turbo` downloaded separately.
- **BlackHole**: virtual audio devices.
- **Discord**: the desktop app only. No SDK and no bot.
- **AivisSpeech** and its voice models. The default host voice コハク is under the Aivis Common Model License (ACML) 1.0. Derived models are allowed, but the licence must travel with them and nothing may pass as the speaker or as official. Keep the credit (`AIVIS_CREDIT`) on stream. `scripts/kohaku-dataset.mjs` writes the model's own licence next to any training audio it makes.
- **Style-Bert-VITS2**, **Supertonic** and **Gemini TTS**: optional voices, each under its own terms.
- **RVC voice-changer applications**: optional and external.
- `scripts/hotkeys.swift` uses Apple's Carbon and AppKit frameworks on the operator's Mac. Nothing of them is redistributed.

The MIT license grants no rights to third-party voices, character models, images, games, recordings, music, trademarks or service accounts. Operators must check the selected voice/character terms and attribution, including redistribution and commercial use. The UI's generated credit suggestion does not replace that check.
