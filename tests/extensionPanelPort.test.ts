/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The docked-panel port (D3 section 3): the overlay's side (dockedPanel.ts), the iframe's side
 * (panelPort.ts) and the shared names (panelProtocol.ts), run with a fake `chrome.runtime`.
 * The real browser path is tests/extension-harness/s3-workers.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { makeNonce, mountDockedPanel } from '../apps/extension/src/overlay/dockedPanel';
import type { PanelPort, PanelRuntime } from '../apps/extension/src/overlay/dockedPanel';
import { mountShadowHost } from '../apps/extension/src/overlay/overlay';
import { listenForPanelPort, readNonce } from '../apps/extension/src/dashboard/panelPort';
import { isPanelPortName, isPanelSnapshot, NONCE_PATTERN, panelPortName } from '../apps/extension/src/shared/panelProtocol';
import { OPTIMIZER_UNAVAILABLE } from '../apps/extension/src/shared/optimizerProtocol';
import { buildSnapshot } from './helpers/simulatorFixtures';

type Listener<A extends unknown[]> = (...args: A) => void;

/** One end of a fake port. `peer` is the other end. */
class FakePort implements PanelPort {
  peer: FakePort | null = null;
  readonly sent: unknown[] = [];
  private onMsg: Listener<[unknown]>[] = [];
  private onDisc: Listener<[]>[] = [];
  constructor(readonly name: string) {}
  readonly onMessage = { addListener: (cb: Listener<[unknown]>) => void this.onMsg.push(cb) };
  readonly onDisconnect = { addListener: (cb: Listener<[]>) => void this.onDisc.push(cb) };
  postMessage(m: unknown): void {
    this.sent.push(m);
    this.peer?.onMsg.forEach((cb) => cb(m));
  }
  disconnect(): void {
    this.onDisc.forEach((cb) => cb());
    this.peer?.onDisc.forEach((cb) => cb());
  }
  closeFromPeer(): void {
    this.onDisc.forEach((cb) => cb());
  }
}

/** A runtime where `connect` reaches the iframe's `onConnect` listeners once `listening` is true. */
function fakeRuntime() {
  const listeners: Listener<[FakePort]>[] = [];
  const ports: FakePort[] = [];
  const state = { listening: false };
  const runtime: PanelRuntime = {
    getURL: (p) => `chrome-extension://abc/${p}`,
    connect: ({ name }) => {
      const mine = new FakePort(name);
      const theirs = new FakePort(name);
      mine.peer = theirs;
      theirs.peer = mine;
      ports.push(mine);
      if (state.listening) listeners.forEach((cb) => cb(theirs));
      else queueMicrotask(() => mine.closeFromPeer()); // "Receiving end does not exist"
      return mine;
    },
  };
  const iframeRuntime = { onConnect: { addListener: (cb: Listener<[FakePort]>) => void listeners.push(cb) } };
  return { runtime, iframeRuntime, ports, state };
}

const windows: HappyWindow[] = [];
function shadowHost(): { host: HTMLElement; fireLoad(el: HTMLElement): void } {
  const win = new HappyWindow({ url: 'https://www.swimcloud.com/meetsimulator/' });
  windows.push(win);
  const host = mountShadowHost(win.document as unknown as Document);
  return { host, fireLoad: (el) => el.dispatchEvent(new win.Event('load') as unknown as Event) };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

describe('panel names and nonce', () => {
  it('a nonce is 32 hex characters and comes from getRandomValues', () => {
    const calls: number[] = [];
    const nonce = makeNonce({
      getRandomValues: ((a: Uint8Array) => {
        calls.push(a.length);
        a.forEach((_, i) => (a[i] = i * 17));
        return a;
      }) as Crypto['getRandomValues'],
    });
    expect(calls).toStrictEqual([16]);
    expect(nonce).toMatch(NONCE_PATTERN);
    expect(makeNonce()).not.toBe(makeNonce());
  });

  it('readNonce accepts only a 32-hex fragment', () => {
    const n = 'a'.repeat(32);
    expect(readNonce(`#${n}`)).toBe(n);
    expect(readNonce('')).toBeNull();
    expect(readNonce('#abc')).toBeNull();
    expect(readNonce(`#${'g'.repeat(32)}`)).toBeNull();
  });

  it('panelPortName round-trips through isPanelPortName, and other names do not match', () => {
    expect(isPanelPortName(panelPortName('x'))).toBe(true);
    expect(isPanelPortName('osx-other')).toBe(false);
    expect(isPanelPortName('')).toBe(false);
  });

  it('validates forwarded simulator snapshots and rejects malformed payloads', () => {
    const snapshot = buildSnapshot('A').snapshot;
    expect(isPanelSnapshot({ kind: 'simulator-snapshot', snapshot })).toBe(true);
    expect(isPanelSnapshot({ kind: 'simulator-snapshot', snapshot: { ...snapshot, teams: 'not teams' } })).toBe(false);
    expect(isPanelSnapshot({ kind: 'simulator-snapshot', snapshot, nonce: 'wrong' })).toBe(true);
    expect(isPanelSnapshot(null)).toBe(false);
  });

  it('the unsupported-request error is explicit', () => {
    expect(OPTIMIZER_UNAVAILABLE).toMatch(/^optimizer not available/);
  });
});

describe('mountDockedPanel (overlay side)', () => {
  it('mounts dashboard.html?host=docked#<nonce> inside the shadow root, not in the page', () => {
    const { host } = shadowHost();
    const { runtime } = fakeRuntime();
    const panel = mountDockedPanel(host, runtime);
    expect(panel.url).toBe(`chrome-extension://abc/dashboard.html?host=docked#${panel.nonce}`);
    expect(panel.nonce).toMatch(NONCE_PATTERN);
    expect(host.shadowRoot?.querySelector('iframe')).toBe(panel.iframe);
    expect(host.ownerDocument.querySelectorAll('iframe')).toHaveLength(0);
    expect(panel.iframe.getAttribute('src')).toBe(panel.url);
    expect(host.dataset.osxPanel).toBe('mounted');
  });

  it('connects on load with the nonce-bearing name, and a pong from the iframe marks it connected', () => {
    const { host, fireLoad } = shadowHost();
    const fake = fakeRuntime();
    fake.state.listening = true;
    const other = listenForPanelPort(fake.iframeRuntime, 'c'.repeat(32));
    const panel = mountDockedPanel(host, fake.runtime);
    // The iframe listens for the nonce it was loaded with, which is the overlay's.
    const own = listenForPanelPort(fake.iframeRuntime, panel.nonce);
    expect(fake.ports).toHaveLength(0); // nothing connects before the iframe loads
    fireLoad(panel.iframe);
    expect(fake.ports.map((p) => p.name)).toStrictEqual([panelPortName(panel.nonce)]);
    expect(own).toStrictEqual({ accepted: 1, rejected: 0, pings: 1, snapshots: 0 });
    expect(other).toStrictEqual({ accepted: 0, rejected: 1, pings: 0, snapshots: 0 }); // another iframe heard it and left it alone
    expect(host.dataset.osxPanel).toBe('connected');
    expect(host.dataset.osxPanelVia).toBe('direct');
    expect(host.dataset.osxPanelAttempts).toBe('1');
    expect(host.dataset.osxPanelPongs).toBe('1');
  });

  it('ignores a pong that carries another nonce', () => {
    const { host, fireLoad } = shadowHost();
    const fake = fakeRuntime();
    fake.state.listening = true;
    const panel = mountDockedPanel(host, fake.runtime);
    fireLoad(panel.iframe);
    fake.ports[0]!.peer!.postMessage({ kind: 'pong', n: 1, nonce: 'f'.repeat(32) });
    expect(host.dataset.osxPanel).toBe('mounted');
  });

  it('retries when the iframe is not listening yet, then gives up as unreachable', async () => {
    vi.useFakeTimers();
    const { host, fireLoad } = shadowHost();
    const fake = fakeRuntime();
    const panel = mountDockedPanel(host, fake.runtime, { maxAttempts: 3, retryDelayMs: 10 });
    fireLoad(panel.iframe);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.ports).toHaveLength(3);
    expect(host.dataset.osxPanel).toBe('unreachable');
  });

  it('a retry connects once the iframe has registered its listener', async () => {
    vi.useFakeTimers();
    const { host, fireLoad } = shadowHost();
    const fake = fakeRuntime();
    const panel = mountDockedPanel(host, fake.runtime, { retryDelayMs: 10 });
    fireLoad(panel.iframe);
    await vi.advanceTimersByTimeAsync(0);
    listenForPanelPort(fake.iframeRuntime, panel.nonce);
    fake.state.listening = true;
    await vi.advanceTimersByTimeAsync(20);
    expect(host.dataset.osxPanel).toBe('connected');
    expect(host.dataset.osxPanelAttempts).toBe('2');
  });
});

describe('listenForPanelPort (iframe side)', () => {
  it('answers a ping on its own port name only, and counts the rest as rejected', () => {
    const fake = fakeRuntime();
    fake.state.listening = true;
    const stats = listenForPanelPort(fake.iframeRuntime, 'a'.repeat(32));
    const foreign = fake.runtime.connect({ name: panelPortName('b'.repeat(32)) }) as FakePort;
    foreign.postMessage({ kind: 'ping', n: 1 });
    expect(foreign.peer!.sent).toStrictEqual([]);
    expect(stats).toStrictEqual({ accepted: 0, rejected: 1, pings: 0, snapshots: 0 });
    const own = fake.runtime.connect({ name: panelPortName('a'.repeat(32)) }) as FakePort;
    own.postMessage({ kind: 'ping', n: 7 });
    own.postMessage({ kind: 'save-lineup' });
    expect(own.peer!.sent).toStrictEqual([{ kind: 'pong', n: 7, nonce: 'a'.repeat(32) }]);
    expect(stats).toStrictEqual({ accepted: 1, rejected: 1, pings: 1, snapshots: 0 });
  });

  it('delivers only validated snapshots from the iframe nonce port', () => {
    const fake = fakeRuntime();
    fake.state.listening = true;
    const seen: unknown[] = [];
    listenForPanelPort(fake.iframeRuntime, 'a'.repeat(32), (snapshot) => seen.push(snapshot));
    const port = fake.runtime.connect({ name: panelPortName('a'.repeat(32)) }) as FakePort;
    const snapshot = buildSnapshot('A').snapshot;
    port.postMessage({ kind: 'simulator-snapshot', snapshot });
    port.postMessage({ kind: 'simulator-snapshot', snapshot: { teams: null } });
    expect(seen).toStrictEqual([snapshot]);
  });
});

describe('a closed port', () => {
  it('is reported to the iframe, so it can stop posting to it', () => {
    const fake = fakeRuntime();
    fake.state.listening = true;
    const nonce = 'd'.repeat(32);
    const opened: unknown[] = [];
    const closed: unknown[] = [];
    listenForPanelPort(fake.iframeRuntime, nonce, undefined, undefined, (port) => opened.push(port), undefined, (port) => closed.push(port));
    // A port with another name is not ours: it is never reported open or closed.
    (fake.runtime.connect({ name: 'someone-else' }) as unknown as FakePort).disconnect();
    expect(opened).toHaveLength(0);
    expect(closed).toHaveLength(0);
    const peer = fake.runtime.connect({ name: panelPortName(nonce) }) as unknown as FakePort;
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(0);
    peer.disconnect();
    expect(closed).toStrictEqual(opened);
  });
});
