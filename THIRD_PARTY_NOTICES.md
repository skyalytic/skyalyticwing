# Third-party materials

The root PolyForm Noncommercial License 1.0.0 covers project-owned material offered under that license. It does not relicense dependencies, external documentation, fonts, media, or separately licensed bundled runtimes. Their existing notices and permissions remain in effect; the project's noncommercial restriction does not replace those component licenses. Project attribution is recorded in `NOTICE`.

## Dependencies and runtimes

- JavaScript dependencies are resolved by `pnpm-lock.yaml`; retain each installed package's copyright, license and notices when redistributing it.
- Rust dependencies are resolved by `src-tauri/Cargo.lock` and retain their own licenses.
- Node.js, Python, FFmpeg and Office runtimes are obtained by the build preparation scripts. Their component licenses, notices and required source distributions remain part of their packaging workflow.
- Office runtime inputs and source locations are recorded in `deploy/office-engine` and `deploy/office-wasm`. The application license does not replace their licenses.
- Existing package names and compatibility identifiers refer to their respective projects; their presence does not imply endorsement.

## Bundled skills and guides

The source includes the personal edition's bundled skills, supporting scripts, references and assets, along with the desktop extension's referenced guides. Existing component metadata and notices are retained. This document inventories the included materials; preparing this directory does not change their license metadata.

## Design references recorded in the source

The original development comments cited deepseek-harness for permission presets, conversation layout and update policy; ZCode for browser/desktop workflow design; and OpenClaw and Hermes-Agent for core types, channel/tool architecture and safety/recovery concepts. Explanatory comments now describe local behavior; this record preserves those references. A design reference alone is not evidence that code was copied, nor is it evidence of permission to redistribute copied code. Verify any actual upstream code imports against their original license and version before release.
