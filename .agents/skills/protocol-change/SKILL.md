---
name: protocol-change
description: Change how IPMI Console talks to a BMC (detection, web login, the KVM session, video, keyboard and mouse reports, power, console sharing, reconnecting) or add support for a firmware variant. Use for any change under src/protocol, src/video or KvmController.
---

# Changing the BMC protocol

Read [docs/architecture.md](../../../docs/architecture.md) (Connecting, Ending a session, Video,
Input) first.

## Where things live

| Concern | File |
|---|---|
| Identifying the BMC (no login) | `src/protocol/detect.ts` |
| Login, launch parameters, logout | `webauth.ts`, `jnlp.ts` (SP); `spx.ts` (SP-X) |
| Connect steps, cancellation, reconnect | `client.ts` (`KvmClient`) |
| Firmware differences | `profiles.ts`; SP parameters from the BMC's client files in `jarprobe.ts` |
| Byte stream | `transport.ts` (TCP, TLS, single-port tunnel), `websocket.ts` (SP-X) |
| Handshake, packet dispatch, closing | `session.ts`, `ivtp.ts` |
| Keyboard and mouse reports | `keymap.ts`, `hid.ts`, `blowfish.ts`, `layouts.ts` |
| What the app does with it | `src/main/kvm-controller.ts`; user-facing errors in `src/main/errors.ts` |

## How to make the change

1. **Simulator first.** Make the simulated BMC behave the way the real one does: a firmware variant
   in `src/sim/firmware.ts` (written from the BMC's side, so it checks `profiles.ts` rather than
   copying it), or a fault in `src/sim/scenario.ts` handled in `src/sim/ivtp-server.ts`. See the
   [simulator skill](../simulator/SKILL.md).
2. **Test against it.** Controller behaviour goes in `tests/main/kvm-controller.test.ts`; build a
   one-off scenario with `withFaults([...])`. Wire-level details go in `tests/integration.test.ts`,
   SP-X in `tests/spx.test.ts`. Each scenario's expected outcome is checked by
   `tests/scenarios.test.ts`.
3. **Then change the protocol code**, keeping these rules:
   - **Cancel-safe connects.** In `client.ts`, call `checkStopped()` after every `await` in the
     connect steps, and run new steps inside `cancellable()`. A disconnect during connect must
     still log out.
   - **Graceful close.** `session.stop()` sends STOP, ends the stream and waits briefly before
     destroying it; `disconnect()` then logs out of the web session. New exit paths must go through it.
     Tests check `bmc.logouts` against `bmc.logins`.
   - **Errors the user can act on.** Map new failures to a message and kind in `src/main/errors.ts`.
     Decide whether a BMC stop reason is worth reconnecting for (`RETRYABLE_STOPS` in `session.ts`).
   - **No secrets in logs.** Tokens and cookies go through `redactArgs` or similar before
     logging; the probe report tests check this.
   - **Input only with control.** Anything that sends keys, mouse or power checks `canControl` in
     `KvmController`.
4. **Firmware profiles.** A new variant gets a profile with `jviewerProfile(...)` or `spxProfile(...)`
   in `profiles.ts`, with an honest `status`, and a case in `selectProfile` / `selectSpxProfile`.

## Checking on real hardware

Only the user can do this. Ask them to run the probe themselves (it reads the password from
`BMC_PASSWORD`; never ask for the password or put it in a command):

```bash
npm run build
BMC_PASSWORD='…' node dist/cli/probe.js --host <bmc-address> --user <user>
```

Read `captures/<host>-<time>/report.json` and `probe.log`. If a session got stuck and the BMC now
refuses KVM sessions, the user can reset its management controller with
`ipmitool -I lanplus -H <bmc-address> -U <user> -a mc reset cold`; see
[docs/troubleshooting.md](../../../docs/troubleshooting.md). Update
[docs/compatibility.md](../../../docs/compatibility.md) only with what was confirmed on the board.

## Done when

`npm run typecheck && npm run lint && npm test` pass, `npm run test:e2e` passes if connecting,
closing or input changed, and the architecture doc still describes the code.
