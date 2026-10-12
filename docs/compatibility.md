# Compatibility

IPMI Console supports BMCs running **AMI MegaRAC** firmware on ASPEED video hardware: the older
**MegaRAC SP** generation (the BMCs whose web page launches a Java console) and the newer
**MegaRAC SP-X** (HTML5 console).

A board is listed as working only after it has been used on real hardware. Everything else is
**experimental**: supported by a firmware profile and tested against the simulator, but not yet
confirmed on that board. If you try one, please [report how it went](#reporting-a-board).

## Status

| Status | Meaning |
|---|---|
| **Working** | Video, keyboard and mouse used on the hardware with this app |
| **Experimental** | Has a firmware profile and simulator tests; not yet confirmed on the hardware |
| **Not supported** | Recognised, but its protocol isn't implemented; the app says so instead of trying to log in |

## Boards

| Board | BMC chip | Firmware | Status |
|---|---|---|---|
| ASRock Rack **E3C226D2I** | AST2300 | MegaRAC SP | **Working**: video, keyboard, mouse, Type clipboard and Copy text on Windows and Linux. Power control and reconnecting after a network drop are not yet confirmed on it. |
| ASUS **ASMB8-iKVM** (e.g. Z10PE-D16 WS) | AST2400 | MegaRAC SP | Experimental |
| ASRock Rack AST2400/2500 boards with MegaRAC SP | AST2400/2500 | MegaRAC SP | Experimental |
| Lenovo ThinkServer **RD450X** | ASPEED | MegaRAC SP | Experimental |
| Tyan **S8030** | AST2500 | MegaRAC SP-X | Experimental |
| ASRock Rack and ASUS boards with the HTML5 console | AST2500/2600 | MegaRAC SP-X | Experimental |
| **OVH** servers (ASRock Rack based) | AST2500 | MegaRAC SP-X | Experimental |
| Other MegaRAC SP and SP-X boards | AST2050–2600 | MegaRAC SP or SP-X | Experimental: the app adapts to the firmware when it connects |

### Not supported yet

Supermicro (ATEN iKVM), Dell iDRAC, HPE iLO and OpenBMC are recognised when you add the server, and
the app tells you they aren't supported.

Some video modes aren't supported either. The app reports encrypted video and the AST2500's JPEG
capture mode when a BMC uses them; AST2600 raw-tile video isn't handled yet.

## How the app adapts to a board

When you add a server, the app identifies the BMC from its web server's responses without logging
in, so a wrong guess can't lock the account. You can override this under **Advanced**.

When it connects, it picks a firmware profile for the details that differ between firmware
versions, such as the session handshake and keyboard reports. On MegaRAC SP it reads them from the
console files the BMC itself serves, so it adapts to firmware builds it hasn't seen before.
[architecture.md](architecture.md#connecting) explains the steps.

## Reporting a board

Whether it works or not, a probe report helps add the board to this list:

```bash
npm install && npm run build
BMC_PASSWORD='…' node dist/cli/probe.js --host <bmc-address> --user <user>
```

The probe changes no settings on the BMC. It writes `report.json` and `probe.log` to
`captures/<host>-<time>/`, and neither contains your password, session tokens or cookies.
[Open an issue](../../../issues) with:

- `report.json` and `probe.log`
- the board model and BMC firmware version
- whether `screen.png` (in the same folder) shows the server's screen correctly; attach it only if
  nothing sensitive is on the screen

More options are in [development.md](development.md#probing-a-real-bmc).
