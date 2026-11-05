# SkyalyticWing Integration Tests

This directory contains integration tests for SkyalyticWing.

## Running Tests

```bash
# Build all public package exports, then run backend/frontend + legacy integration + export checks
pnpm build
pnpm test

# Backend HTTP/WS integration (mock LLM, no external provider calls)
pnpm --filter @skyalyticwing/backend test:e2e --runInBand

# Run legacy core integration tests explicitly
pnpm test:integration

# Run a specific backend regression suite
pnpm --filter @skyalyticwing/backend test --runInBand --runTestsByPath test/unit/browser-origin.spec.ts
```

## Test Structure

```
tests/
├── integration/
│   ├── gateway.test.ts      # Gateway tests
│   ├── agent.test.ts        # Agent tests
│   ├── tool.test.ts         # Tool tests
│   ├── permission.test.ts   # Permission tests
│   ├── memory.test.ts       # Memory tests
│   └── channel.test.ts      # Channel tests
├── vitest.config.ts
└── README.md
```

## Requirements

- Node.js 22+
- Gateway tests bind port 0 on loopback; the OS allocates an available port per test process.
- Test database (optional)

Packages without their own test files have no empty `test` script; this is not a claim of package-level unit coverage. Their public exports are checked by `pnpm test:exports`, and legacy integration tests run against source. Browser Playwright tests in `e2e/` are separate and use a mock backend. `test:e2e` currently uses `--forceExit`; shutdown handle cleanup remains a known follow-up.

`pnpm version:check` checks the root, workspace packages, Tauri and the application entry in Cargo.lock. `pnpm version:sync [X.Y.Z]` updates these files together without updating dependencies. Independent extension manifests and configuration schema versions are not application versions. `pnpm release X.Y.Z` prepares and validates locally; it does not create tags or push. Commit reviewed changes before tagging the exact release commit.

`pnpm test:delivery` exercises version synchronization in isolated temporary directories. SDK discovery/loading tests run with `pnpm test:integration`. PluginLoader discovers `plugin.json` in configured roots and their immediate child directories; it validates manifests and entries without importing code. Explicit `load()` calls require `setTrustedRoots()` or a successful `discover()` first. These path checks do not sandbox trusted plugin code.

The removed `test:commercial` CI invocation had no root script. Scripts named `test-root-commercial*` require the separate website backend and an isolated database; they are not covered by desktop browser acceptance. A dedicated commercial acceptance job still needs that environment. Do not point those scripts at production accounts or payment services.
