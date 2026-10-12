---
name: release
description: Write commit messages, review or merge the release-please release PR, or change packaging, icons, third-party notices, the git hooks or the CI and release workflows of IPMI Console.
---

# Commits, releases and packaging

Full description: [docs/development.md](../../../docs/development.md#commits-and-releases).

## Commits

- Commit or push only when the user asks. Branch first if on `main`.
- Conventional Commits: `type(scope): description`, first line up to 72 characters with no full stop,
  optional body up to 6 lines saying why. `scripts/commit-msg.mjs` refuses anything else.
- The type decides the release: `feat` → minor version, `fix` and `perf` → patch, others → no release
  and hidden from the changelog. Use `!` (`feat!:`) only for a real breaking change.
- One logical change per commit. Never commit `private/`, `captures/`, `artifacts/`, `refs/`, `.jnlp`
  files, or anything with personal details or secrets.
- Don't skip the hooks (`--no-verify`) to get past a failing check; fix the check.

## The release PR

release-please keeps a PR open on `main` that bumps `package.json`, `.release-please-manifest.json`
and `CHANGELOG.md`. Before it's merged, check:

1. The version is what the changes deserve, and the changelog reads well for users. Edit the PR's
   `CHANGELOG.md` if needed.
2. CI is green on `main`.
3. `THIRD_PARTY_NOTICES.md` is current (CI checks it).

Merging creates a draft release and its tag. `.github/workflows/release.yml` then runs the full CI
suite, builds installers on Windows, Linux and macOS, attaches them and publishes the release. If a
build fails, the release stays a draft. Fix the cause on `main` and re-run the workflow.

## Packaging

- **Config:** the `build` section of `package.json` (electron-builder). Output goes to `release/`.
- **Icons:** `build/icon.svg` is the source. `icon.png` (1024 px), `icon.ico` (16–256 px) and
  `icon-256.png` (the window icon, copied to `dist/main/icon.png` by `scripts/build.mjs`) are rendered
  from it. Change all of them together.
- **Contents:** `npm run test:package` builds the unpacked app, checks the archive holds what it
  should (`scripts/package-smoke.mjs`) and runs the e2e suite against it.
- **Notices:** `scripts/notices.mjs`, run by the build, writes `THIRD_PARTY_NOTICES.md` from the
  bundled packages. It ships with the app; never drop a licence notice.
- **Signing:** Windows signs when the `WINDOWS_SIGNING_CERT` and `WINDOWS_SIGNING_CERT_PASSWORD`
  secrets exist. macOS builds have only an ad-hoc signature (`mac.identity: "-"`, which Apple silicon
  needs to open the app at all) and aren't notarised, so users allow them once in System Settings →
  Privacy & Security → Open Anyway.
- **Native binaries:** npm installs the keychain module's binary for the current machine only.
  `scripts/add-native-binaries.mjs` adds others: both Mac CPUs for `dist:mac` and the release
  workflow, or `win32-x64-msvc` for a Windows build on Linux. The package check fails if the binary
  is missing.
- **macOS files** are separate per CPU: `-mac-arm64` (Apple silicon) and `-mac-x64` (Intel).
- **Windows builds on Linux or WSL** can't set the exe icon and details without Wine. CI builds them
  on Windows.

## Workflows

- `.github/workflows/ci.yml`: typecheck, lint, tests with coverage, e2e (development and packaged)
  on Linux, Windows and macOS. Runs on pushes to `main` and on pull requests, and is called by the release
  workflow.
- `.github/workflows/release.yml`: release-please, then build and publish.
- Actions are pinned to commit SHAs with the version in a comment; keep it that way when updating.
