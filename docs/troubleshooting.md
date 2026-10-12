# Troubleshooting

When something goes wrong, the session log usually says why. To see it, open the session
settings menu (the sliders button in the console) and choose **Show log**. The same log is kept in
the `logs` folder of the app's settings folder:

| System | Settings folder |
|---|---|
| Windows | `%APPDATA%\IPMI Console` |
| macOS | `~/Library/Application Support/IPMI Console` |
| Linux | `~/.config/IPMI Console` |

## Opening the app

**Windows: "Windows protected your PC".** The app isn't code-signed yet. Choose **More info →
Run anyway**.

**macOS: which file?** Apple menu → **About This Mac**. If **Chip** says Apple M1 or later, download
the `-mac-arm64` file; if it says **Processor** … Intel, download `-mac-x64`.

**macOS: "Apple could not verify IPMI Console is free of malware" (or "cannot be opened because the
developer cannot be verified").** The app isn't notarised by Apple yet. Click **Done**, open **System
Settings → Privacy & Security**, scroll down and click **Open Anyway** next to IPMI Console, then confirm.
On macOS 14 and earlier, right-clicking the app and choosing **Open** also works. You only need to do
this once.

**Linux: the AppImage doesn't start.** Make it executable first: `chmod +x IPMI*.AppImage`.

## Connecting

**"The BMC accepted the login but not the KVM session".** Another KVM session is still open on the
BMC, and BMCs allow very few. It's often one left behind by a viewer that was closed without
disconnecting. In order:

1. Close any other console you have open to this server, including the BMC's own viewer.
2. Wait a few minutes: the BMC times abandoned sessions out.
3. End the session in the BMC's web interface, if it lists active sessions.
4. Reset the BMC's management controller. This doesn't touch the server itself or the BMC's network
   settings, and takes a few minutes:
   ```bash
   ipmitool -I lanplus -H <bmc-address> -U <user> -a mc reset cold
   ```
   `ipmitool -I lanplus -H <bmc-address> -U <user> -a mc info` answers again once the BMC is back.
   If it still won't connect after that, a second reset sometimes helps.

IPMI Console always logs out when you disconnect, close the window or shut down, so it doesn't leave
sessions behind itself.

**"Maximum number of KVM sessions reached on the BMC".** Same cause as above: close other sessions
and try again.

**"No free slot for web session" or "Web login failed".** The BMC's pool of web logins is full.
Log out of the BMC's web interface in your browser, or wait for those sessions to expire.

**"Invalid username or password".** Check them in the BMC's web interface. Some BMCs lock an
account for a while after several failed logins.

**"KVM is disabled for this user or on this BMC".** The account needs remote-console privilege, or
the KVM service is turned off in the BMC's settings.

**"Connection refused" or "Cannot reach the BMC".** Check the address, and that this computer can
reach the BMC's network. If the BMC's web interface uses a port other than 80 or 443, set it under
**Advanced** when editing the server.

**"Asking for access…".** Another user already has the console, and the BMC has asked them to
share it. They can give you full control, let you watch only (**View only** in the status bar), or
deny access.

## Saved passwords

**Where they're kept.** A remembered password is saved in your system's credential store, under
"IPMI Console": **Credential Manager → Windows Credentials** on Windows, **Keychain Access** on
macOS, or your keyring (for example **Passwords and Keys**) on Linux. Untick **Remember password**
or delete the server to remove it.

**"The password could not be saved in this computer's credential store".** On Linux, a keyring
service must be running: GNOME Keyring, KWallet or another Secret Service provider. Minimal desktops
and remote sessions often don't start one. Without it, connect without remembering the password.

**macOS asks whether IPMI Console may use your keychain.** This can happen after updating the app.
Choose **Always Allow**.

## Certificates

**"presented a certificate that is not trusted".** Most BMCs use a self-signed certificate. Compare
the SHA-256 fingerprint shown with the one in the BMC's web interface (usually under SSL or
certificate settings). Trust it only if they match. IPMI Console then remembers it for that address,
and warns you if it ever changes.

**Old BMCs that only speak TLS 1.0 or 1.1.** Edit the server, open **Advanced** and tick **Allow
legacy TLS 1.0/1.1 for this host**.

## Keyboard and mouse

**Keys repeat, stick or don't register.** Edit the server, open **Advanced**, and change **Keyboard
compatibility** to the other setting. It applies from the next connection. **Automatic** suits most
servers.

**Typed clipboard text has wrong characters.** Type clipboard needs to know the keyboard layout set
in the server's operating system. Choose it in the session settings menu, or under **Server keyboard
layout** when editing the server. BIOS setup screens always use US.

**The pointer doesn't line up with the server's.** The BMC is in relative mouse mode, which some
operating systems need. IPMI Console switches to it automatically: click the screen to lock the
pointer, and press Ctrl+Alt+Shift to release it.

**Keyboard input stopped.** Input may be paused (Ctrl+Alt+Shift): click the screen to resume. If
another user shares the console, you may have view-only access; the status bar shows it.

## Video

**"No signal from host".** The server's display is asleep or off. Press a key or move
the mouse to wake it, or check the server is powered on.

**Copy text doesn't find the text.** Copying text (Ctrl+Alt+C) works on text screens: BIOS setup,
boot messages, and text consoles. It doesn't work on graphical desktops yet.

## Reporting a problem

[Open an issue](../../../issues) with what you did, what happened, and the log. The log never
contains your password, session tokens or cookies. For a board that won't connect, the probe report
helps most: see [development.md](development.md#probing-a-real-bmc).
