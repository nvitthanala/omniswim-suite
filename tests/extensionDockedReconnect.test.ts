import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { mountDockedPanel } from '../apps/extension/src/overlay/dockedPanel';
import type { PanelPort, PanelRuntime } from '../apps/extension/src/overlay/dockedPanel';
import { mountShadowHost } from '../apps/extension/src/overlay/overlay';
import { buildSnapshot } from './helpers/simulatorFixtures';

class Port implements PanelPort {
  sent: unknown[] = [];
  messages: ((m: unknown) => void)[] = [];
  disconnected: (() => void)[] = [];
  postMessage(m: unknown) { this.sent.push(m); }
  disconnect() {}
  onMessage = { addListener: (cb: (m: unknown) => void) => this.messages.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => this.disconnected.push(cb) };
  drop() { this.disconnected.forEach(cb => cb()); }
  pong(nonce: string) { this.messages.forEach(cb => cb({ kind: 'pong', nonce, n: 1 })); }
}

const windows: HappyWindow[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(windows.splice(0).map(w => w.happyDOM.close())); });

describe('docked panel reconnect', () => {
  it('reconnects after an answered port drops and resends the latest snapshot', async () => {
    vi.useFakeTimers();
    const win = new HappyWindow({ url: 'https://www.swimcloud.com/meetsimulator/' }); windows.push(win);
    const host = mountShadowHost(win.document as unknown as Document);
    const ports: Port[] = [];
    const runtime: PanelRuntime = { getURL: p => `chrome-extension://abc/${p}`, connect: () => { const p = new Port(); ports.push(p); return p; } };
    const panel = mountDockedPanel(host, runtime, { retryDelayMs: 5 });
    panel.iframe.dispatchEvent(new win.Event('load') as unknown as Event);
    const snapshot = buildSnapshot('A').snapshot;
    panel.sendSnapshot(snapshot);
    ports[0]!.pong(panel.nonce);
    ports[0]!.drop();
    await vi.advanceTimersByTimeAsync(5);
    expect(ports).toHaveLength(2);
    expect(ports[1]!.sent).toContainEqual({ kind: 'simulator-snapshot', snapshot });
  });

  it('bounds reconnect attempts and shows a visible error', async () => {
    vi.useFakeTimers();
    const win = new HappyWindow({ url: 'https://www.swimcloud.com/meetsimulator/' }); windows.push(win);
    const host = mountShadowHost(win.document as unknown as Document);
    const ports: Port[] = [];
    const runtime: PanelRuntime = { getURL: p => `chrome-extension://abc/${p}`, connect: () => { const p = new Port(); ports.push(p); return p; } };
    const panel = mountDockedPanel(host, runtime, { maxAttempts: 2, retryDelayMs: 5 });
    panel.iframe.dispatchEvent(new win.Event('load') as unknown as Event);
    ports[0]!.drop();
    await vi.advanceTimersByTimeAsync(5);
    ports[1]!.drop();
    await vi.advanceTimersByTimeAsync(20);
    expect(ports).toHaveLength(2);
    expect(host.dataset.osxPanel).toBe('unreachable');
    expect(host.shadowRoot?.querySelector('[data-osx-panel-error]')?.textContent).toMatch(/disconnected/i);
    expect((host.shadowRoot?.querySelector('[data-osx-panel-error]') as HTMLElement).hidden).toBe(false);
  });

  it('keeps reconnecting a panel that answers, however often its port drops', async () => {
    vi.useFakeTimers();
    const win = new HappyWindow({ url: 'https://www.swimcloud.com/meetsimulator/' }); windows.push(win);
    const host = mountShadowHost(win.document as unknown as Document);
    const ports: Port[] = [];
    const runtime: PanelRuntime = { getURL: p => `chrome-extension://abc/${p}`, connect: () => { const p = new Port(); ports.push(p); return p; } };
    const panel = mountDockedPanel(host, runtime, { maxAttempts: 2, retryDelayMs: 5 });
    panel.iframe.dispatchEvent(new win.Event('load') as unknown as Event);
    for (let i = 0; i < 5; i += 1) { ports[i]!.pong(panel.nonce); ports[i]!.drop(); await vi.advanceTimersByTimeAsync(5); }
    expect(ports).toHaveLength(6);
    expect(host.dataset.osxPanel).toBe('connected');
  });
});
