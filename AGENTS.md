# AGENTS.md

How to work on IPMI Console as an AI coding agent: the rules, the layout and the checks. The detail
is in [docs/](docs/).

IPMI Console is a desktop app that opens the remote console (KVM: screen, keyboard, mouse, power) of
servers whose BMC runs AMI MegaRAC SP or SP-X firmware, with no Java. It's Electron, TypeScript and
React. Windows comes first, then Linux and macOS.

## Orientation

| Read | For |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Processes, layers, connect flow, video and input paths, the IPC boundary, settings and secrets |
| [docs/development.md](docs/development.md) | Commands, tests and their optional inputs, the simulator, the probe, installers, commits and releases |
| [docs/compatibility.md](docs/compatibility.md) | Which boards work, and how support is claimed |
| [docs/troubleshooting.md](docs/troubleshooting.md) | User-facing problems and their fixes |

## Code map

```text
src/protocol    BMC detection, web login, KVM session (IVTP), HID reports, TLS, transports  (no Electron)
src/video       ASPEED tile decoder                                                        (no Electron)
src/textrec     reading text back from the screen, terminal-style selection                (no Electron)
src/main        Electron main: window, IPC + validation, settings, keychain, logs, KvmController
src/preload     exposes src/shared/api.ts to the window as window.ojv
src/shared      api.ts: the typed IPC contract
src/renderer    React UI, video engine + decode worker, input capture
src/sim         simulated BMC: scenarios, faults, video sources                            (no Electron)
src/cli         probe (real hardware), sim
tests/          Vitest: unit, controller (tests/main), components (tests/renderer)
e2e/            Playwright: the built app against the simulator
scripts/        build, notices, commit-msg check, package smoke test, table generators
build/          app icons (icon.svg is the source)
```

## Commands

```bash
npm install && npx install-electron --no   # once
npm start                                  # build and run
npm test                                   # unit + component tests
npm run test:e2e                           # the app against the simulator
npm run typecheck && npm run lint
npm run sim -- --scenario demo             # simulated BMC: 127.0.0.1, port 8080, admin/admin
```

## Golden rules

These outrank feature work.

1. **No personal details anywhere public.** Code, tests, fixtures, docs, commit messages and
   network requests carry no names, email addresses, real IP addresses, hostnames or board serials.
   Use example values: `192.0.2.10`, `bmc.example`, `admin`.
2. **No secrets.** Saved passwords live only in the OS credential store (`src/main/keychain.ts`:
   Windows Credential Manager, macOS Keychain, Linux Secret Service), never in the settings file,
   and are never logged or shown. `.jnlp` files carry session tokens: never commit them. Logs and
   probe reports redact tokens and cookies; keep it that way. Never ask for a BMC password or put
   one in a command: the user runs anything that needs it themselves.
3. **Never strand a BMC session.** BMCs allow very few KVM sessions, and one left open blocks the
   next connection. Every exit path logs out: disconnect, cancel, close, quit, OS shutdown, crash,
   Ctrl+C. Changes to connecting or closing need a test that counts logouts against the simulator.
4. **The window is untrusted.** Every IPC handler checks the sender and validates its arguments in
   `src/main/validate.ts`. Keep context isolation, the sandbox, and the content security policy in
   `src/main/window.ts`. No remote content.
5. **Every BMC behaviour has a simulator test.** Model new behaviour in `src/sim` first, then test
   against it. Claims about real hardware say which board they were checked on.
6. **Describe behaviour, not origins.** Comments and docs say what the protocol and the code do,
   not how that was found out. Don't copy code from other products. Keep licence notices intact
   (`THIRD_PARTY_NOTICES.md`, `src/video/tables-aspeed-mpl.ts`).
7. **Vendor-neutral simulator.** Simulated screens and README images use invented values: no vendor
   names, copyright lines or real board identities.
8. **Write like the code around you.** Match naming and comment density; comments explain why, not
   what. No bloated comments. Remove what you replace.

## Before you finish

- `npm run typecheck && npm run lint && npm test`. The pre-push hook runs the same.
- `npm run test:e2e` if you changed the UI, input, or connecting and closing.
- Look at UI changes: run the app against the simulator, or `npm run screenshots` if README
  images would change.
- `npm run build` regenerates `THIRD_PARTY_NOTICES.md` when dependencies change; commit it.
- Update the docs your change makes wrong.

## Commits

- Conventional Commits, kept short; `scripts/commit-msg.mjs` enforces it. Details are in
  [docs/development.md](docs/development.md#commits-and-releases).
- Commit or push only when asked.
- Never commit `private/`, `captures/`, `artifacts/`, `refs/` or `.jnlp` files. They're gitignored
  because they hold vendor files, screens or tokens.

## Skills

Task guides in `.agents/skills/`. Read the matching `SKILL.md` before starting that kind of work.

| Skill | Use when |
|---|---|
| [protocol-change](.agents/skills/protocol-change/SKILL.md) | Changing login, the KVM session, video, keyboard or mouse, power, or adding a firmware variant |
| [simulator](.agents/skills/simulator/SKILL.md) | Adding a simulator scenario or fault, or changing a simulated screen |
| [ui-change](.agents/skills/ui-change/SKILL.md) | Changing screens, dialogs, the toolbar, input capture or styles |
| [release](.agents/skills/release/SKILL.md) | Preparing commits, reviewing the release PR, or changing packaging and CI |
