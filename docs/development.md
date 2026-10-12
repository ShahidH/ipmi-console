# Development

How to build, run and test IPMI Console. For how the code fits together, see
[architecture.md](architecture.md).

## Setup

Needs **Node.js 22.12+** and git.

```bash
npm install                 # also installs the git hooks (see Commits)
npx install-electron --no   # downloads Electron itself, once
npm start                   # build and run the app
```

No BMC? Start the simulator in a second terminal (`npm run sim -- --scenario demo`), then add
server `127.0.0.1`, port `8080`, user and password `admin`.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Build and run the app |
| `npm run build` | Bundle main, preload, renderer and the decode worker into `dist/`, and regenerate `THIRD_PARTY_NOTICES.md` |
| `npm test` | Unit and component tests (Vitest) |
| `npm run test:coverage` | The same, with a coverage report in `coverage/` |
| `npm run test:e2e` | Build, then run the real app against the simulator (Playwright) |
| `npm run test:package` | Package the app unpacked, check its contents, and run the e2e suite against the packaged app |
| `npm run test:all` | Typecheck, lint, coverage and e2e (CI also runs `test:package`) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run sim -- …` | The simulated BMC (see below) |
| `npm run probe -- …` | Read-only checks and a short session against a real BMC (see below) |
| `npm run screenshots` | Regenerate the README images in `.github/assets/` |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Build installers into `release/` |

## Tests

| Where | What | Runs with |
|---|---|---|
| `tests/*.test.ts` | Protocol, decoder, text recognition, layouts, TLS, the simulator, and whole connections against it | `npm test` |
| `tests/main/` | `KvmController` against the simulator, including faults (drops, BMC stops, sharing, power); settings files; IPC validation | `npm test` |
| `tests/renderer/` | Screens and dialogs with a fake API (`fake-api.ts`), in jsdom | `npm test` |
| `e2e/` | The built app driving the simulator: connect, video, input, copy and paste, reconnect, closing | `npm run test:e2e` |

Each e2e test gets its own simulator and a throwaway profile folder (`e2e/fixtures.ts`), so tests
run in parallel and never touch your saved servers.

Some tests run only when their inputs are present, and are skipped otherwise:

| Test | Needs |
|---|---|
| Decoder against ASPEED's reference decoder | `gcc`, and `OJV_ASPEED_CODEC` set to a checkout of [aspeed_codec](https://github.com/AspeedTech-BMC/aspeed_codec)'s `src/` folder |
| Real captures and recordings | Frames or recordings from `probe` in `captures/` (gitignored: they show your server's screen) |
| Fingerprinting real client files | `OJV_REAL_JARS` set to a folder with the client files downloaded from your own BMC |
| TLS certificate policy | `openssl` |
| Blowfish against the JDK | `java` |
| Layout tables against Linux | xkb data (`/usr/share/X11/xkb`) |

Other variables: `OJV_DEBUG=1` adds debug lines to the log, and `OJV_USER_DATA` runs the app with
another profile folder.

**WSL:** the e2e tests use WSLg's display. If several fail at once with `X connection error
received` in the log, WSLg dropped its connections; `wsl --shutdown` from Windows resets it. CI
uses a virtual display and isn't affected.

## The simulator

`npm run sim -- --list` shows every scenario and firmware variant. Useful ones:

| Scenario | Shows |
|---|---|
| `demo` | A firmware setup screen: ←/→ switch menus, ↑/↓ select, +/- change options |
| `sp-195` (default) | A text console that echoes what you type |
| `spx-438` | An SP-X BMC over WebSocket |
| `drop` | The network dropping after 3 s, then reconnecting |
| `kvm-in-use` | Another user asking for access |
| `max-sessions` | The BMC refusing because all KVM sessions are taken |

Options: `--port` (web, default 8080), `--kvm-port`, `--user` / `--password` (default
`admin`), `--fps`, `--captures DIR` (play captured frames), `--replay FILE` (play a recorded session).

To add a scenario or fault, see `src/sim/scenario.ts`; faults are carried out in
`src/sim/ivtp-server.ts`.

## Probing a real BMC

`probe` detects the BMC, logs in, runs a short KVM session and writes a report. It changes no BMC
settings and sends no input unless asked (`--wake`, `--type`).

```bash
npm run build
BMC_PASSWORD='…' node dist/cli/probe.js --host <bmc-address> --user admin
```

The password comes only from the environment. Output goes to `captures/<host>-<time>/`: raw
frames, `screen.png` (the decoded screen), `probe.log` and `report.json`. The log and report hold
no password, token or cookie, so they're safe to attach to an issue; the frames and `screen.png`
show the server's screen.

Options include `--https`, `--port`, `--frames`, `--seconds`, `--family`, `--profile`,
`--legacy-tls`, `--trust-fingerprint` and `--record` (save the session for `sim --replay`).
`src/cli/probe.ts` lists them all.

**If a BMC stops accepting KVM sessions,** usually because one was left open, reset its management
controller. It keeps its network settings:

```bash
ipmitool -I lanplus -H <bmc-address> -U admin -a mc reset cold
```

The BMC takes a few minutes to come back; `ipmitool … mc info` answers again once it's up.

## Building installers

`npm run dist:win` (or `dist:mac`, `dist:linux`) builds into `release/`:

- **Windows:** an installer and a portable `.exe`
- **macOS:** `.dmg` and `.zip` for Apple silicon (`-mac-arm64`) and Intel (`-mac-x64`). They carry an
  ad-hoc signature, which Apple silicon needs to open the app at all, but aren't notarised yet
- **Linux:** an `.AppImage`

The app icon's source is `build/icon.svg`; `icon.png` (1024 px), `icon.ico` (16–256 px) and
`icon-256.png` (the window icon) are rendered from it.

npm installs the keychain module's native binary only for the machine it runs on. `dist:mac` adds
both Mac binaries first (`scripts/add-native-binaries.mjs`), since one Mac builds both apps. To build
for Windows on Linux, add that binary the same way: `node scripts/add-native-binaries.mjs
win32-x64-msvc`. electron-builder still can't set the exe's icon and details there without Wine, so
CI builds Windows installers on Windows.

## Third-party notices

`npm run build` regenerates `THIRD_PARTY_NOTICES.md` from the packages actually bundled, plus the
MPL-2.0 notice for `src/video/tables-aspeed-mpl.ts`. Commit it when dependencies change; CI fails
if it's out of date.

## Commits and releases

The git hooks (Husky) run on every commit and push:

| Hook | Runs |
|---|---|
| pre-commit | ESLint on the staged files |
| commit-msg | `scripts/commit-msg.mjs`: the message format below |
| pre-push | Typecheck, lint and unit tests |

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) and stay short:

```
fix(video): clamp tile colours

Large deltas wrapped round to black on bright screens.
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`;
  `!` after the type marks a breaking change.
- **First line:** up to 72 characters, no full stop.
- **Body:** optional, up to 6 lines, saying why rather than every detail.

[release-please](https://github.com/googleapis/release-please) reads them on `main` and keeps a
release PR open with the next version and `CHANGELOG.md`:

- `feat` raises the minor version (0.1 → 0.2), and `fix` and `perf` the patch version.
- The other types don't make a release, and are left out of the changelog.

Merging the release PR creates a draft release and its tag. `.github/workflows/release.yml` then runs
the full CI suite, builds the installers on Windows, Linux and macOS, attaches them and publishes the
release. Windows code signing turns on when the `WINDOWS_SIGNING_CERT` and
`WINDOWS_SIGNING_CERT_PASSWORD` secrets exist.

If a build fails, the release stays a draft. Fix the cause on `main`, then run **Actions → Release →
Run workflow** with the tag (e.g. `v0.1.0`) to build and publish it again.
