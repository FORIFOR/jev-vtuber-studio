# Security

This is a local release candidate, not a hardened hosted service. Both servers bind to loopback only. The optional rc.3 mobile gateway accepts only a configured Tailscale Serve origin and explicit user identity. The full admin and OBS endpoints must never be remotely forwarded. This remote boundary is implemented and tested locally, not externally security-certified.

- Keep Control URLs, keys, OAuth tokens and data/ private. Settings are plaintext, Unix0600, not an OS keychain. Protect backup files and Windows ACLs.
- Viewer input is data, never operator authority. Do not add arbitrary command/browser execution to the chat pathway.
- Typed model judgments can be wrong. Keep local controls and evaluate false accepts/rejects with representative inputs.
- A media playback ACK does not prove audible output or delivery to the audience. Keep explicit human checks and rehearsal.
- Dependency pins do not prove safety; inspect optional grpc dependencies before deployment. This environment did not install them.

If this source has been published in a GitHub repository with private vulnerability reporting enabled, use that repository's private report feature. The current archive does not contain a configured security mailbox or confirmed reporting endpoint. Do not put working credentials, private chat logs or an active exploit against someone else's installation into a public issue. Contact the actual repository maintainer privately before disclosure; redact sensitive details from general bug reports.

No automatic public broadcasting/rebroadcasting is performed. If the model/runtime/network fails, do not bypass output review to restore speech. Emergency stop cannot retract media already buffered by YouTube, and PC/OBS/network failures can prevent a stop request from reaching its destination.

Source distributions include `.gitignore`/`.npmignore`. Default `data/`, `.env`, dependency folders and build output are excluded. This is an accidental-add guard, not encryption, secret scanning, or protection from `git add -f`. Already tracked secrets remain tracked; remove them and rotate any exposed credentials. A custom `DATA_DIR` must be outside the checkout or explicitly ignored. Packaging rejects known private paths and uses a curated source snapshot; it does not inspect arbitrary prose for every possible secret.

## rc.3 private remote boundary

See docs/REMOTE.md and docs/REMOTE_IMPLEMENTATION.md. TLS and identity headers are supplied by a trusted local Tailscale Serve reverse proxy. Headers are spoofable by other local processes; the desktop is trusted. Never bind to 0.0.0.0, never use Funnel, and do not substitute a proxy that forwards attacker-controlled identity headers. Restrict users and devices in Tailscale. Shared devices with the same allowed login are not independently distinguished by the app.

The gateway checks Host, user allowlist, Origin/Fetch metadata, HttpOnly Secure SameSite cookies and per-session CSRF. Only explicit start, stop, panic and status are exposed. It cannot set keys, execute commands, choose arbitrary endpoints, claim audio, or remove a panic latch. Local OBS playback proof plus human recording/destination confirmation arms starts for eight hours. Expiry, settings changes and reboot invalidate permission. Stops remain possible after arming expires, but network loss prevents commands from arriving.

Control acknowledgments are not proof of physical output or YouTube publication. Only own streams are stopped; delayed or unobservable stop results are shown as unconfirmed. Manual concurrent changes by another OBS controller are outside atomic control; use a dedicated OBS session. No remote endpoint has been publicly deployed by the authors of this package.
