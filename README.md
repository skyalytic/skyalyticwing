# SkyalyticWing

<p><img src="packages/frontend/public/logo-transparent.png" alt="Skyalytic Logo" width="160" /></p>

English | [简体中文](README.zh-CN.md)

[Website](https://skyalytic.com/) · [Personal edition downloads](https://skyalytic.com/download) · [Documentation](https://docx.skyalytic.com/) · [Enterprise and commercial licensing](https://skyalytic.com/contact)

SkyalyticWing is Skyalytic's AI workspace for model conversations, tool execution, project files, and desktop workflows. It uses React for the interface, NestJS for the local backend, and Tauri for the desktop shell. This repository provides the community source without Wing sign-in, available for use, modification and sharing under a noncommercial license.

## What's new in 2.1.1

- Task center with progress, results, approvals, answers, notifications and prompt revisions.
- Durable task scheduling, proactive rules, delivery queues and interrupted-task recovery.
- SSH, WSL and Docker workspaces with remote files, terminals, Git, Office editing and isolated child worktrees.
- Responses API support, context checkpoints and browser recovery.

This repository keeps its account-free design. See [task and remote workspace usage](docs/tasks-and-remote-workspaces.md) for setup, recovery and verification boundaries.

## Companion enterprise edition

SkyalyticWing Enterprise is a separate product with enterprise accounts, organizations, seats, departments, organizational budgets and resource approvals. Employees control their own API keys without spending organizational credits; organization-issued keys follow organization permissions and quotas.

| Edition                   | Usage                                                                                           | Availability                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| This community source     | No Wing account; own API keys or local models; noncommercial license                            | Build from this repository                                                                                                                        |
| Official personal edition | Official installer; features and service terms are specified on the website                     | [Download](https://skyalytic.com/download)                                                                                                        |
| Enterprise edition        | Separate enterprise identity and team administration; scope defined by the commercial agreement | [Contact Skyalytic](https://skyalytic.com/contact) for paid licensing and delivery; enterprise source and public installers are not provided here |

Contact Skyalytic for commercial use, team deployment or the enterprise edition. This repository's license does not grant commercial-use rights.

## Requirements

- Node.js 24; see `package.json` for the supported engine range.
- The pnpm version specified by `packageManager` in `package.json`.
- For desktop builds: Rust and the platform dependencies required by Tauri. Windows needs MSVC build tools and WebView2; macOS needs Xcode Command Line Tools; Linux needs GTK and WebKitGTK development packages.

## Install and run

```sh
pnpm install --frozen-lockfile
```

The backend listens on `127.0.0.1:19111`; the frontend development server uses port `1421`. Allow the development frontend origin before starting either development command. This is currently necessary because the backend's built-in development exception still uses port `1420`.

PowerShell:

```powershell
$env:SKYALYTICWING_ALLOWED_ORIGINS = 'http://localhost:1421,http://127.0.0.1:1421'
pnpm dev
```

Bash / zsh:

```sh
export SKYALYTICWING_ALLOWED_ORIGINS='http://localhost:1421,http://127.0.0.1:1421'
pnpm dev
```

To start the Tauri development window, run `pnpm desktop:dev` instead of `pnpm dev` in the same configured shell.

`.env.example` documents configuration options. Node.js does not automatically load that file: set environment variables in the launching shell or load an environment file explicitly. Never commit real credentials or user data.

## Accounts and service boundaries

- No Wing account or sign-in is required. Configure your own API provider or connect a local model through Ollama, LM Studio or vLLM. Remote providers and online tools still require a network; offline use requires local models and runtimes to be prepared first.
- Wing accounts, the official model gateway, memberships, credits, check-in, payments, purchases, publisher payouts and organization resource assignments are removed. Custom chat/media providers and local tools do not check Wing account entitlements. Anonymous resource catalogs, skill ZIP import/export and third-party connector authorization remain available.
- The separate enterprise application, website backend, production data, and operational credentials are not included.
- The local service is intended for a trusted, single-user environment. Loopback binding and browser-origin checks do not authenticate other native processes on the computer. Token authentication is optional in the current implementation; review [security guidance](SECURITY.md) before changing network exposure.
- Treat the application data directory as sensitive. Stored provider configuration can contain API keys. Protect the local data directory and do not publish it.
- Skills, plugins, and desktop automation can act on local resources. A JavaScript execution session is not an operating-system security sandbox.

## Checks and builds

Before building, you can use the development app without a Wing account: open the model provider settings, add your provider, model ID, endpoint and API key, then save and select the model in the chat composer. For a local model, use its running service endpoint and model ID, with authentication if required by that service. Select a project folder for file operations and grant the permissions needed for the task. Third-party connectors may require separate credentials or authorization.

Run checks relevant to your changes:

```sh
pnpm version:check
pnpm lint
pnpm type-check
pnpm test:delivery
pnpm test:public-source
pnpm build
pnpm desktop:check
```

Build a local test installer on the target operating system:

```sh
pnpm desktop:build --local-test
```

Packaging downloads and verifies platform runtimes, then checks staging and installer contents. The first build can take longer. Signing, remote publishing, and update-feed deployment require separate configuration; see [build instructions](BUILD_DEPLOY.md).

The Windows UIA bridge is included as a prebuilt packaging input at `packages/web/binaries/windows-bridge.exe`; retain this file when distributing the repository. The separate WGC screenshot helper is built from the Rust source included in this repository.

## Repository layout

| Path                                           | Purpose                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `packages/frontend`                            | Conversation UI, settings, and project workspace                  |
| `packages/backend`                             | Sessions, models, tools, extensions, and local services           |
| `packages/cli`                                 | Command-line entry points                                         |
| `packages/shared`, `sdk`, `tools`, `providers` | Shared workspace packages                                         |
| `src-tauri`                                    | Native windows, platform integration, and installer configuration |
| `scripts`, `tests`                             | Build tooling and verification                                    |
| `config`                                       | Edition identity, release policy, and packaging manifests         |
| `deploy`                                       | Optional runtime and service deployment configuration             |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow. Keep changes focused, explain behavior and design decisions, and include relevant validation. Use isolated test data instead of real accounts or message recipients. Report security issues through [SECURITY.md](SECURITY.md), not a public issue containing credentials or exploit details.

## License

Project-owned material is provided under the [PolyForm Noncommercial License 1.0.0](LICENSE). Noncommercial use, modification and redistribution are permitted subject to its full terms; commercial use requires separate authorization. This is a source-available, noncommercial license, not an [OSI-defined open-source license](https://opensource.org/osd).

Retain the attribution in [NOTICE](NOTICE) and the license. Dependencies, fonts, runtimes, and materials with separate licenses retain their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This licensing change does not revoke licenses already lawfully granted for earlier copies.
