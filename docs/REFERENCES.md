# Primary specifications and reference designs

These describe external APIs, not evidence that this archive has passed a production integration test.

- TypeSafe typed decision API: https://docs.typesafe.ai/api
- TypeSafe concepts: https://docs.typesafe.ai/introduction
- YouTube streaming chat / official proto / API key and OAuth: https://developers.google.com/youtube/v3/live/streaming-live-chat
- YouTube streamList: https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList
- YouTube list / polling interval: https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list
- Ollama native chat / keep_alive / think: https://docs.ollama.com/api/chat
- VOICEVOX Engine API: https://voicevox.github.io/voicevox_engine/api/
- VOICEVOX terms: https://voicevox.hiroshiba.jp/term/
- OBS browser source: https://obsproject.com/kb/browser-source
- OBS WebSocket protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
- VTube Studio API (legacy optional bridge): https://github.com/DenchiSoft/VTubeStudio
- Original reference design: https://github.com/ponyo877/jev-telop-live

The default talk build does not install all eight referenced Jev ecosystem projects. NanoJev training, browser agents, arbitrary game control, search agents, context plugins and general automation are outside this release's default flow. See the earlier v0.1.0 archive for its original research/game experiment; the current source retains opt-in legacy code without claiming updated production validation.
