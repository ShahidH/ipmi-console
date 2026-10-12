---
name: simulator
description: Add or change a scenario, fault, firmware variant or video source in the simulated BMC (src/sim), which unit tests, e2e tests, demos and README screenshots run against.
---

# Working on the simulator

The simulator is a BMC: web login (SP or SP-X), the KVM transports, and the IVTP session. Tests,
`npm run sim`, the e2e suite and the README screenshots all use it, so a change here affects all of
them. Overview: [docs/development.md](../../../docs/development.md#the-simulator).

## Where things live

| Concern | File |
|---|---|
| Scenarios and faults | `src/sim/scenario.ts` (`SCENARIOS`, `Fault`) |
| Carrying out faults, BMC replies | `src/sim/ivtp-server.ts` |
| Web layer, transports, login and logout counts | `src/sim/server.ts` (`SimBmc`) |
| Firmware variants | `src/sim/firmware.ts`; the client files the SP web layer serves: `fakejar.ts` |
| Received keyboard and mouse, lock-key LEDs | `src/sim/input.ts` |
| Video sources | `video.ts` (`TextScreen`, `CaptureSource`), `demo-screen.ts` (the setup screen), `recording.ts` (replays) |
| Frame encoding | `encoder.ts` |

## Adding a scenario or fault

1. **A fault** is a new member of the `Fault` union in `scenario.ts`, with a comment saying what the
   BMC does, and a `case` in `ivtp-server.ts`. Timed faults use `at` (ms after the session starts).
2. **A scenario** is an entry in `SCENARIOS` with a name, a one-line description (it's shown by
   `npm run sim -- --list`) and `expect`. `tests/scenarios.test.ts` connects to every scenario and
   checks `expect`, so a new one is tested automatically.
3. **One-off test setups** don't need a named scenario: tests build one with `withFaults([...])`
   (`tests/main/kvm-controller.test.ts`).
4. **Test what the app does with it,** not just that the simulator sends it: in the controller tests,
   and in `e2e/` if the user sees it.

Write the simulator from the BMC's point of view. It mirrors `src/protocol/profiles.ts` but doesn't
import it, so a mistake on one side shows up as a failing test instead of being copied to both.

## Simulated screens

- `VideoSource` gives a `full()` frame and `next()` changes (or `null`); `key(usage)` lets a screen
  react to the keyboard. `TextScreen` draws character cells; `'vga'` uses the VGA 8×16 font at
  800×600, `'8x8'` the small font.
- Keep text readable by `src/textrec`: `tests/sim-setup.test.ts` decodes the screen and reads it back.
- **Vendor-neutral and invented:** no vendor names, product names, copyright lines or real board
  identities. Values look plausible but are made up (`SIM-1000`, "Example CPU").
- If you change the `demo` screen, run `npm run screenshots` to regenerate the README images, and
  look at them.

## Done when

`npm test` passes (including `tests/scenarios.test.ts` and `tests/sim-setup.test.ts`), and
`npm run test:e2e` if the e2e suite uses what you changed. `npm run sim -- --list` describes any new
scenario clearly.
