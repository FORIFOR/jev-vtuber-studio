# Contributing

Start with the fixed-script demo and `npm run release:check`. Node.js 22.12+ is required; no production secrets or paid service calls are required for core tests. Optional gRPC dependencies are installed explicitly with `npm run setup:youtube`.

Keep provider I/O behind adapters and inject clocks/responses in tests. Add regression tests for stop/restart, stale generations, duplicate comments, failed later audio parts and ownership changes. Never remove the whole-turn output gate or make an API error silently fall back to unreviewed text.

Use small changes with a clear user-visible outcome. Include the reproduction, expected behavior, automated tests and actual tested environment. UI changes should include desktop/mobile screenshots without keys or Control URLs. Do not claim that mock tests or isolated DOM checks prove real-service performance.

A useful first contribution is real-environment verification using docs/VALIDATION.md. Record model/runtime/voice versions, OS and OBS versions, latency components and failures, without uploading private comments or credentials. Only submit voice/model assets you have redistribution rights for; original code is MIT, external assets may not be.

Run `npm run pack:release` to create a local archive and inspect its contents. This does not publish. Maintain `README.md` and `README.en.md` together and keep limitations accurate. For sensitive findings, follow SECURITY.md rather than public issue disclosure.
