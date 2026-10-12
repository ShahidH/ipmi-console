// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { parseAddress, ServerDialog } from '../../src/renderer/components/ServerDialog';
import { ToastProvider } from '../../src/renderer/components/Toasts';
import { initialSession, type SessionState } from '../../src/renderer/hooks/useKvmSession';
import { ConsoleScreen } from '../../src/renderer/screens/ConsoleScreen';
import { relativeTime } from '../../src/renderer/screens/ServersScreen';
import { installFakeApi, server } from './fake-api';

afterEach(() => cleanup());

describe('parseAddress', () => {
  it('takes scheme and port from a pasted URL', () => {
    expect(parseAddress('https://10.0.0.5:8443/#login')).toEqual({ host: '10.0.0.5', scheme: 'https', port: 8443 });
    expect(parseAddress(' bmc.lan ')).toEqual({ host: 'bmc.lan', scheme: undefined });
    expect(parseAddress('[fe80::1]:443')).toEqual({ host: 'fe80::1', scheme: undefined, port: 443 });
  });
});

describe('relativeTime', () => {
  it('reads naturally', () => {
    const now = 1_000_000_000;
    expect(relativeTime(undefined, now)).toBe('Never');
    expect(relativeTime(now - 30_000, now)).toBe('Just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 26 * 3600_000, now)).toBe('Yesterday');
  });
});

describe('servers screen', () => {
  it('shows saved servers with reachability, and filters by search', async () => {
    const { api } = installFakeApi([server(), server({ id: 's2', name: 'edge-gw', host: '10.0.20.40' })]);
    api.reachability.mockResolvedValue({ s1: true, s2: false });
    render(<App />);
    const nas = await screen.findByRole('article', { name: 'nas-01' });
    await waitFor(() => expect(within(nas).getByText('Reachable')).toBeTruthy());
    expect(within(screen.getByRole('article', { name: 'edge-gw' })).getByText('No response')).toBeTruthy();

    await userEvent.type(screen.getByRole('searchbox'), '10.0.20');
    expect(screen.queryByRole('article', { name: 'nas-01' })).toBeNull();
    expect(screen.getByRole('article', { name: 'edge-gw' })).toBeTruthy();
  });

  it('asks for the password when none is saved, then connects', async () => {
    const { api } = installFakeApi([server()]);
    render(<App />);
    await userEvent.click(within(await screen.findByRole('article', { name: 'nas-01' })).getByRole('button', { name: 'Connect' }));
    await userEvent.type(screen.getByLabelText('Password for admin@192.168.1.50'), 'secret');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Password' })).getByRole('button', { name: 'Connect' }));
    expect(api.connect).toHaveBeenCalledWith('s1', 'secret');
    expect(await screen.findByRole('button', { name: 'Servers' })).toBeTruthy();
  });

  it('offers to trust an unknown certificate and retries', async () => {
    const { api } = installFakeApi([server({ hasPassword: true })]);
    api.connect.mockResolvedValueOnce({ error: 'not trusted', kind: 'certificate', fingerprint: 'AA:BB', subject: 'CN=bmc' });
    render(<App />);
    await userEvent.click(within(await screen.findByRole('article', { name: 'nas-01' })).getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Check the BMC certificate' });
    expect(within(dialog).getByText('SHA-256 AA:BB')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trust for 192.168.1.50' }));
    expect(api.trustCertificate).toHaveBeenCalledWith('192.168.1.50', 'AA:BB');
    await waitFor(() => expect(api.connect).toHaveBeenCalledTimes(2));
  });

  it('shows why a connect failed and stays on the list', async () => {
    const { api } = installFakeApi([server({ hasPassword: true })]);
    api.connect.mockResolvedValueOnce({ error: 'Maximum number of KVM sessions reached', kind: 'busy' });
    render(<App />);
    await userEvent.click(within(await screen.findByRole('article', { name: 'nas-01' })).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Maximum number of KVM sessions reached')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Servers' })).toBeTruthy();
  });
});

describe('server dialog', () => {
  it('identifies the BMC from the address before credentials', async () => {
    const { api } = installFakeApi();
    render(<ServerDialog onSave={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('BMC address'), 'https://10.0.0.5:8443');
    expect(await screen.findByText('Found AMI MegaRAC SP (Java JViewer generation)', {}, { timeout: 2000 })).toBeTruthy();
    expect(api.detect).toHaveBeenLastCalledWith('10.0.0.5', 'https', 8443);
  });

  it('warns about BMCs it does not support', async () => {
    const { api } = installFakeApi();
    api.detect.mockResolvedValue({ reachable: true, family: 'dell-idrac', familyName: 'Dell iDRAC', supported: false, scheme: 'http' });
    render(<ServerDialog onSave={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('BMC address'), '10.0.0.9');
    expect(await screen.findByText('This looks like Dell iDRAC', {}, { timeout: 2000 })).toBeTruthy();
  });

  it('saves what was entered', async () => {
    installFakeApi();
    const onSave = vi.fn(async () => {});
    render(<ServerDialog onSave={onSave} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('BMC address'), 'http://10.0.0.5:8080/');
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ host: '10.0.0.5', webScheme: 'http', webPort: 8080, username: 'admin', password: 'pw', name: '' }), true);
  });
});

describe('console screen', () => {
  const live: SessionState = { ...initialSession, phase: 'connected', target: { name: 'nas-01', host: '192.168.1.50' }, step: 'Connected', connectedAt: Date.now(), info: { power: 1, mouseMode: 2 } };
  const renderConsole = (session: SessionState, handlers: Partial<Parameters<typeof ConsoleScreen>[0]> = {}) =>
    render(<ToastProvider><ConsoleScreen session={session} onDisconnect={vi.fn()} onRetryNow={vi.fn()} onReconnect={vi.fn()} {...handlers} /></ToastProvider>);

  beforeEach(() => { installFakeApi(); });

  it('runs power actions immediately, with no confirmation', async () => {
    const { api } = installFakeApi();
    renderConsole(live);
    await userEvent.click(screen.getByRole('button', { name: 'Power' }));
    expect((screen.getByRole('menuitem', { name: /Power on/ }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('menuitem', { name: /Hard reset/ }));
    expect(api.power).toHaveBeenCalledWith('reset');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Hard reset sent to nas-01.')).toBeTruthy();
  });

  it('sends key combinations from the Keys menu', async () => {
    const { api } = installFakeApi();
    renderConsole(live);
    await userEvent.click(screen.getByRole('button', { name: 'Keys' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Ctrl + Alt + Del' }));
    expect(api.chord).toHaveBeenCalledWith('ctrl-alt-del');
  });

  it('closes menus with Escape', async () => {
    renderConsole(live);
    await userEvent.click(screen.getByRole('button', { name: 'Power' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('counts down to the next reconnect attempt and can retry now', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onRetryNow = vi.fn();
    const now = Date.now();
    renderConsole({ ...live, phase: 'reconnecting', reason: 'connection reset', lostAt: now, reconnect: { attempt: 3, max: 8, delaySec: 4, scheduledAt: now } }, { onRetryNow });
    expect(screen.getByText('Connection lost. Trying again in 4 s')).toBeTruthy();
    expect(screen.getByText(/Attempt 3 of 8/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(2100); });
    expect(screen.getByText('Connection lost. Trying again in 2 s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onRetryNow).toHaveBeenCalled();
    vi.useRealTimers();
  });

  /** The remote screen, sized so pointer positions can be computed. */
  const screenCanvas = () => {
    const c = document.querySelector('canvas')!;
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    return c;
  };

  it('sends PrintScreen that arrives as key-up only (Windows) as a press and a release', () => {
    const { api } = installFakeApi();
    renderConsole(live);
    fireEvent.keyUp(screenCanvas(), { code: 'PrintScreen' });
    expect(api.key.mock.calls).toEqual([['PrintScreen', true], ['PrintScreen', false]]);
  });

  it('releases a modifier whose key-up went missing', () => {
    const { api } = installFakeApi();
    renderConsole(live);
    const c = screenCanvas();
    fireEvent.keyDown(c, { code: 'ShiftLeft', shiftKey: true });
    // The Shift key-up never arrived; the next key says Shift is not held.
    fireEvent.keyDown(c, { code: 'KeyA' });
    expect(api.key.mock.calls).toEqual([['ShiftLeft', true], ['ShiftLeft', false], ['KeyA', true]]);
  });

  it('adds up small wheel movements into one scroll step and ignores sideways scrolling', () => {
    const { api } = installFakeApi();
    renderConsole(live);
    const c = screenCanvas();
    const wheels = () => api.mouse.mock.calls.filter(([m]) => m.wheel);
    fireEvent.wheel(c, { deltaX: 120, deltaY: 0 });
    fireEvent.wheel(c, { deltaY: 20 });
    fireEvent.wheel(c, { deltaY: 20 });
    expect(wheels()).toEqual([]);
    fireEvent.wheel(c, { deltaY: 20 });
    expect(wheels().map(([m]) => m.wheel)).toEqual([-1]);
    fireEvent.wheel(c, { deltaY: -100 });
    expect(wheels().map(([m]) => m.wheel)).toEqual([-1, 1]);
  });

  it('releases the mouse button on the server when a drag ends outside the screen', () => {
    const { api } = installFakeApi();
    renderConsole(live);
    const c = screenCanvas();
    fireEvent.mouseDown(c, { clientX: 100, clientY: 100, buttons: 1 });
    fireEvent.mouseUp(document.body, { clientX: 900, clientY: 100, buttons: 0 });
    expect(api.mouse.mock.calls.at(-1)![0]).toMatchObject({ buttons: 0 });
  });

  it('view-only access: says so, and keeps keyboard, mouse and power off', async () => {
    const { api } = installFakeApi();
    renderConsole({ ...live, info: { ...live.info, access: 'view-only', sharedWith: 'operator (10.1.2.3)' } });
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.getByText('Shared with operator (10.1.2.3)')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Type clipboard' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screenCanvas(), { code: 'KeyA' });
    expect(api.key).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Power' }));
    expect((screen.getByRole('menuitem', { name: /Hard reset/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows that it is waiting for the other user to allow access', () => {
    renderConsole({ ...live, info: { ...live.info, access: 'waiting', sharedWith: 'operator (10.1.2.3)' } });
    expect(screen.getByText('Asking for access…')).toBeTruthy();
    expect(screen.getByText('Waiting for access')).toBeTruthy();
  });

  it('says so when the BMC refuses a power command', async () => {
    const { api } = installFakeApi();
    api.power.mockResolvedValue('refused');
    renderConsole(live);
    await userEvent.click(screen.getByRole('button', { name: 'Power' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Hard reset/ }));
    expect(await screen.findByText('The BMC refused hard reset.')).toBeTruthy();
  });

  it('disables session controls while not live', () => {
    renderConsole({ ...live, phase: 'connecting', step: 'Logging in…' });
    expect((screen.getByRole('button', { name: 'Type clipboard' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Logging in…').length).toBeGreaterThan(0);
  });
});

describe('access requests from other users', () => {
  it('closes unanswered after 30 seconds, as JViewer does, without answering', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, emit } = installFakeApi();
    render(<App />);
    act(() => emit('kvm:shareRequest', { user: 'operator', ip: '10.1.2.3' }));
    expect(screen.getByText(/operator \(10.1.2.3\) is asking/)).toBeTruthy();
    expect(screen.getByText(/within 30 seconds/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(31000); });
    expect(screen.queryByText(/is asking/)).toBeNull();
    expect(api.answerShare).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('closes when the request is withdrawn or the session ends', () => {
    const { emit } = installFakeApi();
    render(<App />);
    act(() => emit('kvm:shareRequest', { user: 'operator', ip: '10.1.2.3' }));
    act(() => emit('kvm:shareRequest', null));
    expect(screen.queryByText(/is asking/)).toBeNull();
    act(() => emit('kvm:shareRequest', { user: 'operator', ip: '10.1.2.3' }));
    act(() => emit('kvm:ended', { reason: 'gone', willReconnect: false }));
    expect(screen.queryByText(/is asking/)).toBeNull();
  });

  it('shows session notices', async () => {
    const { emit } = installFakeApi();
    render(<App />);
    act(() => emit('kvm:notice', { title: 'operator allowed view only.' }));
    expect(await screen.findByText('operator allowed view only.')).toBeTruthy();
  });
});
