# Wrightbench

[![CI](https://github.com/Wrightbench/wrightbench/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Wrightbench/wrightbench/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Wrightbench/wrightbench?sort=semver)](https://github.com/Wrightbench/wrightbench/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Wrightbench** is a desktop studio for recording, running, debugging and
reviewing [Playwright](https://playwright.dev) test suites. It brings
Playwright's scattered tools — codegen, UI Mode, the trace viewer and HTML
reports — into one Electron workspace, with multi-project management,
persistent run history and flakiness analytics.

> **Status: early development (0.x).** APIs, storage formats and UI are
> still moving. Expect breaking changes between minor versions until 1.0.

## Download

Installers for tagged releases are published on the
[GitHub Releases page](https://github.com/Wrightbench/wrightbench/releases):

| Platform | Artifact |
| --- | --- |
| macOS (Apple Silicon) | `Wrightbench-<version>-mac-arm64.dmg` / `.zip` |
| macOS (Intel) | `Wrightbench-<version>-mac-x64.dmg` / `.zip` |
| Windows x64 | `Wrightbench-Setup-<version>-win-x64.exe` |
| Linux x64 | `Wrightbench-<version>-linux-x86_64.AppImage` and `wrightbench_<version>_amd64.deb` |

Every release ships a `SHA256SUMS` manifest, an SPDX SBOM, and GitHub
[artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations)
so downloads can be verified:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify <artifact> --repo Wrightbench/wrightbench
```

macOS builds are Developer ID signed and notarized; Windows installers are
Authenticode signed. Supported platforms: macOS 13+ (arm64 and x64),
Windows 10/11 x64, and x64 Linux distributions that can run AppImage or
Debian packages.

## Building from source

Prerequisites:

- Node.js as pinned in [`.nvmrc`](.nvmrc) (a current LTS; `nvm use` picks it up)
- npm 10+
- Git
- A native build toolchain for the bundled SQLite module
  ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3)):
  Xcode Command Line Tools on macOS, Visual Studio Build Tools on Windows,
  `build-essential` + Python on Linux

```bash
git clone https://github.com/Wrightbench/wrightbench.git
cd wrightbench
npm ci
npx electron-rebuild -f -w better-sqlite3   # rebuild SQLite for Electron's ABI
```

### Development commands

```bash
npm run dev            # launch the app with hot reload
npm run typecheck      # TypeScript over main/preload and renderer projects
npm run test:uimode    # main-process test suite (isolated HOME)
npm run build          # production build to out/
```

### Packaging commands

```bash
npm run package        # build + unpacked app in release/ (no installer)
npm run dist           # build + platform installers in release/
```

Local `npm run dist` output is unsigned unless you have signing
credentials configured; official signed builds come from the
[release pipeline](docs/RELEASING.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and
[AGENTS.md](AGENTS.md) for the project's architecture and design-system
rules. Security issues should be reported privately — see
[SECURITY.md](SECURITY.md). This project follows the
[Contributor Covenant](CODE_OF_CONDUCT.md).

## License

Wrightbench is licensed under the [Apache License 2.0](LICENSE).
Third-party components bundled in the packaged app are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The Apache License does not grant permission to use the Wrightbench name
or logo (see Section 6 of the license). Please don't use the Wrightbench
branding in a way that suggests your project or build is published or
endorsed by the Wrightbench maintainers.

Wrightbench is an independent project and is not affiliated with or
endorsed by Microsoft or the Playwright project.
