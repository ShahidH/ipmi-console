---
name: ui-change
description: Change IPMI Console's window (screens, dialogs, toolbar, menus, status bar, toasts, styles, or keyboard and mouse capture in src/renderer), and check the result visually.
---

# Changing the UI

The window is a sandboxed React app. It can only call the API in `src/shared/api.ts` (`window.ojv`,
through `src/renderer/api.ts`), and it is treated as untrusted. Background:
[docs/architecture.md](../../../docs/architecture.md).

## Where things live

| Concern | File |
|---|---|
| Which screen, the connect flow, global toasts | `src/renderer/App.tsx` |
| Saved servers, add and edit | `screens/ServersScreen.tsx`, `components/ServerDialog.tsx` |
| The console: toolbar, overlays, status bar | `screens/ConsoleScreen.tsx` |
| Session state from main-process events | `hooks/useKvmSession.ts` (a pure reducer) |
| Keyboard and mouse capture | `hooks/useInputCapture.ts` |
| Dialogs, menus, toasts | `components/Modal.tsx`, `Menu.tsx`, `Dialogs.tsx`, `Toasts.tsx` |
| Video canvas, copy text | `video/engine.ts`, `decode-worker.ts`, `components/TextSelect.tsx` |
| Styles and colour tokens | `styles.css` (`--bg`, `--accent`, `--danger`, …) |

## Rules

- **New data or actions** need a call or event in `src/shared/api.ts`, the handler in
  `src/main/ipc.ts` with its arguments validated in `src/main/validate.ts`, the bridge in
  `src/preload/preload.ts`, and the fake in `tests/renderer/fake-api.ts`.
- **Video stays outside React.** Frames go from IPC to the worker; components read stats from the
  engine. Don't route frames through state.
- **Input capture:** keys go as `KeyboardEvent.code`; there's no capture click; Ctrl+Alt+Shift
  pauses until the screen is clicked; relative-mouse BMCs need pointer lock, which only a click can
  start. Every key or button pressed must be released, including when focus leaves the window.
- **Only send input with control.** Respect `session.info.access` (`full`, `view-only`, `waiting`).
- **Colours come from the tokens** in `styles.css`; no hard-coded colours in components.
- **Accessibility:** every control has a visible label or `aria-label`; icons are `aria-hidden`;
  dialogs use `Modal` (traps focus, Escape closes, focus returns); status changes use a live
  region; keep `:focus-visible` outlines.
- **Wording:** short, plain, and says what to do next. Errors come from `src/main/errors.ts` where
  possible, so the UI and logs agree.

## Testing and looking at it

1. **Component tests** in `tests/renderer/screens.test.tsx` render screens with the fake API. Drive
   them like a user (Testing Library, `userEvent`) and assert what's visible.
2. **End-to-end** in `e2e/`, with the real app against the simulator (`npm run test:e2e`).
3. **Look at it.** Start the simulator (`npm run sim -- --scenario demo`) and the app
   (`npm start`); check small and large windows and full screen. Or run `npm run screenshots`, which
   writes the README images to `.github/assets/`, and open them. Regenerate those images whenever
   the change would make them out of date.

## Done when

`npm run typecheck && npm run lint && npm test` and `npm run test:e2e` pass, and you've looked at
the change rather than only tested it.
