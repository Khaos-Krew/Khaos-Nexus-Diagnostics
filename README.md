# Khaos Nexus Diagnostics

Independent, updateable diagnostics runtime for the Khaos Nexus desktop application.

## Purpose

This repository owns the standalone diagnostics interface, diagnostic report engine, local redaction rules, and release payload consumed by Khaos Nexus. Keeping it separate allows diagnostic fixes to be distributed without rebuilding the full desktop application.

## Safety model

- The desktop app downloads only published GitHub Release assets from this repository.
- Every archive and extracted file is verified with SHA-256 before activation.
- A runtime must declare a supported diagnostics API version and compatible desktop version range.
- The last verified runtime is retained for rollback.
- The installer always contains an embedded fallback, so diagnostics remain available offline or when an update fails.
- Reports remain local by default and `secrets.bin` is never copied.

## Release process

1. Update files under `payload/`.
2. Add or update tests.
3. Bump the version in `package.json`.
4. Push to `main`.
5. GitHub Actions validates the runtime and publishes an immutable `v<version>` release containing the runtime ZIP and manifest.

The Khaos Nexus desktop app checks the latest published release and stages a verified runtime in its AppData directory for the next diagnostic session.
