# D3 storage, D1 build, S3 workers: OmniSwim extension

Status: spec, 2026-10-25. Author: Claude architect (Opus, read-only), written
into the repo by the lead. Builds against D2 (`D2-ENGINE-API.md`). Where this
spec names a D2 type (`RulePreset`, `SessionPreset`, `Lineup`, `Gender`,
`Provenance`), use D2's final export. Do not define a local copy.

Evidence key: [doc] = quoted from a fetched page (URL given).
[spec] = HTML spec or MDN. [unverified] = not documented in what was read;
the named harness test settles it. [repo] = read in this repo.

Section 9 lists where this spec changed the plan.

---

## 0. Decisions

| # | Decision |
| --- | --- |
| 0.1 | Build with **esbuild**, one build call per entry. Not Vite. Not a CRX plugin. `dist/` is not committed. |
| 0.2 | **A content script never touches IndexedDB.** Its reads and writes go through the service worker (SW). |
| 0.3 | The **docked dashboard is an extension-page iframe** (`dashboard.html?host=docked`) inside a shadow-root container on the simulator page. It is not React mounted directly in the shadow DOM. |
| 0.4 | **S3: the AutoBuilder worker runs in an extension page** (the dashboard tab or the docked iframe) with `new Worker('optimizer.worker.js')`. No offscreen document in v1. No blob worker. |
| 0.5 | WebAssembly runs only in extension pages and their workers. The CSP sets `'wasm-unsafe-eval'` explicitly. |
| 0.6 | Storage uses `idb@8`, with `fake-indexeddb` in tests. |
| 0.7 | Every write is an optimistic `rev` check inside one transaction. Change notices go over `chrome.storage.local` plus `storage.onChanged`. |
| 0.8 | Built-in presets (NSISC, generic) live in code. They are never copied into IndexedDB. |
| 0.9 | Permissions: `storage`, `unlimitedStorage`. No `host_permissions` in v1 (section 2.6). |
| 0.10 | SwimCloud requests run only from a content script on www.swimcloud.com, never from the SW or an extension page. |

---

## 1. Contexts and origins (read this first)

| Context | Origin | IndexedDB it sees | Can `new Worker(ext URL)` | CSP that governs it |
| --- | --- | --- | --- | --- |
| `sim-bridge` (MAIN world) | www.swimcloud.com | SwimCloud's | no | SwimCloud's page CSP |
| `sim-overlay` (ISOLATED world) | www.swimcloud.com | **SwimCloud's** [doc 1] | no [spec 2] | isolated-world CSP [unverified] |
| `service-worker` | chrome-extension://id | extension's [doc 1] | no (no `Worker` in a SW) | `extension_pages` [doc 3] |
| `dashboard.html` tab | chrome-extension://id | extension's | yes | `extension_pages` |
| docked iframe (`dashboard.html?host=docked`) | chrome-extension://id | extension's, unpartitioned [doc 4] | yes | `extension_pages`; the host page's `frame-src` may block the frame [unverified] |
| `optimizer.worker` | chrome-extension://id | do not open | n/a | `extension_pages` ("applies to page and worker contexts" [doc 3]) |

- [doc 1] https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies : "calling web storage APIs accesses data from the host page the content script is injected on"; IndexedDB is a web storage API there.
- [spec 2] https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker : the URL "must be same-origin with the caller's document, or a `blob:` or `data:` URL".
- [doc 3] https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- [doc 4] https://privacysandbox.google.com/3pcd/storage-partitioning : "the extension pages continue to have access to their top-level partition".

---

## 2. D1: build tooling and manifest

### 2.1 Recommendation: extend the esbuild pipeline

1. **Content scripts and the SW must be classic scripts.** Rollup and
   Rolldown (Vite 8) cannot emit IIFE from a multi-input code-splitting build,
   so Vite would need one pass per content script anyway. The legacy esbuild
   pattern is already one build per entry (`extensions/swimcloud-companion/build.mjs`) [repo].
2. **Deterministic output.** The legacy freshness test relied on esbuild giving
   byte-identical output for fixed options
   (`tests/swimCloudExtensionBuildFreshness.test.ts`) [repo].
3. **The metafile makes invariant #7 a cheap test** (section 2.5).
4. **CRX plugins rejected** (`@crxjs/vite-plugin`, WXT): they own the manifest,
   load content scripts through web-accessible dynamic imports (fingerprintable),
   still need manual MAIN-world, offscreen and worker setup, and add a
   dependency with an uncertain maintenance record.
5. **Lost: Vite HMR for the dashboard.** Use `esbuild.context().watch()`
   (`npm run dev:extension`) and reload by hand.
6. **No Tailwind in the extension.** Tailwind v4 declares `@property` rules,
   which CSS ignores inside shadow trees. Use plain CSS with `--osx-*` custom
   properties.

### 2.2 Entries

| Entry | Source | Output | Format | Loaders | Notes |
| --- | --- | --- | --- | --- | --- |
| sim-bridge | `src/bridge/main.ts` | `sim-bridge.js` | iife | — | **P0-dependent** (2.7). Under 5 KB. No globals leaked. |
| sim-overlay | `src/overlay/main.ts` | `sim-overlay.js` | iife | `.css: 'text'` | Engine re-score, light-DOM controls, shadow host for the iframe. |
| service-worker | `src/sw/main.ts` | `service-worker.js` | iife | — | Classic SW, as in the legacy precedent. |
| dashboard | `src/dashboard/main.tsx` | `dashboard.js` + `dashboard.css` | iife | `.css: 'css'` | One bundle, two hosts (`?host=tab`, `?host=docked`). |
| optimizer.worker | `src/worker/optimizer.ts` | `optimizer.worker.js` | iife | — | Finds the wasm with `new URL('highs.wasm', self.location.href)`. Workers have no `chrome.*`. |

Static copies: `manifest.json`, `dashboard.html` (no inline script),
`light.css`, `highs.wasm` (path from S4). Shared options: `bundle: true`,
`platform: 'browser'`, `target: ['chrome120']`, generated-file `banner`,
`metafile: true`, `legalComments: 'none'`, `minify: false` for the first
release.

### 2.3 Files

```
apps/extension/
  package.json         esbuild pinned EXACT (no caret), idb, react, react-dom, zod, recharts;
                       dev: fake-indexeddb, @types/chrome
  build.config.mjs     entries, sharedBuildOptions, staticFiles, outDir (single source of truth)
  build.mjs            CLI: builds all entries + copies static -> dist/; --watch
  static/              manifest.json, dashboard.html, light.css
  src/{bridge,overlay,sw,dashboard,worker,storage,shared}/
  dist/                gitignored
```

### 2.4 `dist/` is not committed (a change from the legacy precedent)

P3, P4 and P5 run in parallel and all rebuild `sim-overlay.js` and
`dashboard.js`. Committed bundles would conflict on every parallel merge, and
HiGHS wasm would be a binary in git. The stale-bundle guard moves into the test
below, following `scripts/run-harness.mjs`: skip locally, fail on CI.

### 2.5 Tests (each fails if its invariant breaks)

`tests/extensionBuildFreshness.test.ts`
- T-B1 Entry guard: entry names equal exactly
  `['dashboard','optimizer.worker','service-worker','sim-bridge','sim-overlay']`
  (or without `sim-bridge` if recon removes it).
- T-B2 Each entry builds in memory twice; outputs are byte-equal.
- T-B3 If `apps/extension/dist/` exists, each output equals the in-memory
  build after CRLF normalization and each static file equals its source. If
  absent, skip with "run npm run build:extension"; **fail** when
  `process.env.CI` is set.
- T-B4 `esbuild.version` equals the exact pin in `apps/extension/package.json`.

`tests/extensionBundleBoundaries.test.ts` (metafile `inputs` and output text)
- T-B5 (invariant #7) No input starts with `node:`, contains `playwright-core`,
  or matches `packages/swimcloud/src/(index|cache|fetcher|playwrightFetcher|captureStore)\.ts`.
  No input under `legacy/`, and not `packages/ui/src/index.css`.
- T-B6 (0.2) `sim-bridge` and `sim-overlay` outputs contain no `indexedDB`
  identifier and no input under `src/storage/idb`.
- T-B7 `service-worker`, `optimizer.worker`, `sim-bridge`, `sim-overlay`
  contain no `eval(` and no `new Function(` (MV3 CSP blocks both at run time).
- T-B8 No output has a top-level `import` or `export`.
- T-B9 Every selector in `static/light.css` begins with `.osx-` or `[data-osx`.

CI: run `npm run build:extension` **before** `npm test`.

### 2.6 Manifest V3 skeleton

```json
{
  "manifest_version": 3,
  "name": "OmniSwim for SwimCloud",
  "version": "0.1.0",
  "minimum_chrome_version": "120",
  "key": "<base64 public key; see note>",
  "permissions": ["storage", "unlimitedStorage"],
  "background": { "service_worker": "service-worker.js" },
  "action": { "default_title": "OmniSwim" },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  },
  "content_scripts": [
    { "matches": ["https://www.swimcloud.com/meetsimulator/*"],
      "js": ["sim-bridge.js"], "world": "MAIN", "run_at": "document_start" },
    { "matches": ["https://www.swimcloud.com/meetsimulator/*"],
      "js": ["sim-overlay.js"], "css": ["light.css"], "run_at": "document_idle" }
  ],
  "web_accessible_resources": [
    { "resources": ["dashboard.html"],
      "matches": ["https://www.swimcloud.com/*"], "use_dynamic_url": false }
  ]
}
```

| Item | Needed by | Install warning |
| --- | --- | --- |
| `storage` | change bus (5.3): `chrome.storage.local` + `onChanged`, usable from content scripts | none [doc 5] |
| `unlimitedStorage` | user data exempt from quota and eviction (5.7) | none [doc 5] |
| content_scripts on `www.swimcloud.com/meetsimulator/*` | S1 | that host |
| `web_accessible_resources` dashboard.html | docked iframe (3) | none; probe-able by the page if it knows the ID. Accepted for personal use; revisit in P9. |
| `extension_pages` CSP with `'wasm-unsafe-eval'` | HiGHS (default CSP disables wasm [doc 3]) | — |
| `action` | opens the dashboard tab (`tabs.create` needs no `tabs` permission) | none |
| `key` | stable extension ID across folder moves, so the IndexedDB origin stays the same [doc 6] | — |
| **not requested:** `host_permissions` | no extension-origin context requests SwimCloud (0.10). Add only if recon picks the DNR widening route (2.7). | |
| **not requested:** `offscreen` | add only if fallback C is taken (3) | none |
| **not requested:** `declarativeNetRequest` | warning "Block content on any page"; use `declarativeNetRequestWithHostAccess` if ever needed | |

`minimum_chrome_version: 120` covers offscreen `getContexts` (116), port
messages keeping the SW alive (114) [doc 7], `color-mix()` and the manifest
`world` key (Chrome 111 figure [unverified]).

`key`: generate a local RSA key (standard; the docs show the Web Store route
[doc 6]). Commit only the public key. Never commit the private key.

- [doc 5] https://developer.chrome.com/docs/extensions/reference/permissions-list
- [doc 6] https://developer.chrome.com/docs/extensions/reference/manifest/key
- [doc 7] https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- [doc 8] https://developer.chrome.com/docs/extensions/reference/api/offscreen

### 2.7 What depends on recon P0, and the rule for each outcome

The MAIN world at `document_start` runs "before any other DOM is constructed
or any other script is run" [doc 9].

| How the simulator delivers data | `sim-bridge` | Manifest change | Wider window (R7, only if S2 succeeds) |
| --- | --- | --- | --- |
| **JSON via fetch or XHR** | MAIN world at `document_start`. Wrap `window.fetch` and `XMLHttpRequest.prototype.open/send` before page scripts run. `clone()` only responses whose URL matches the one pattern recon pins; never read other bodies. Post `{source:'osx-bridge', v:1, url, body}` with `window.postMessage(msg, location.origin)`. | none | MAIN world rewrites the one parameter in the outgoing URL. No new permission. |
| **Server-rendered HTML** | Drop `sim-bridge`. ISOLATED reads the DOM at `document_idle` plus a `MutationObserver`. | remove the MAIN entry; update T-B1 | Rewrite the query of a navigation the user starts. Never navigate on the extension's own timer. |
| **Inline `<script type="application/json">`** | No MAIN world. ISOLATED reads `textContent`. | remove the MAIN entry | as above |
| **Inline JS global or framework store** | MAIN world at `document_idle`; read the global once; use the network hook for updates if controls fire XHR. | `run_at: document_idle` | as the JSON row |
| **Fetch inside a page worker or page SW** | Page-thread hooks see nothing; fall back to the DOM; flag as fragile. | — | only through DNR (adds `host_permissions` + `declarativeNetRequestWithHostAccess`). Ask the user first. |

**Bridge trust rule.** The page can forge any `postMessage`. Bridge data has
page-level trust. `sim-overlay` validates its shape and never starts a storage
write or a SwimCloud request from a bridge message alone.

- [doc 9] https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts

---

## 3. S3: worker strategy for HiGHS and scoring

| Option | Works? | Evidence | Verdict |
| --- | --- | --- | --- |
| A. Content script `new Worker(chrome.runtime.getURL(...))` | No: worker URL must be same-origin with swimcloud.com | [spec 2] | Rejected |
| B. Blob worker from a content script | Only if SwimCloud's CSP allows `blob:` workers (`worker-src` → `child-src` → `script-src` → `default-src` [spec 10]); wasm then under the page CSP [unverified] | [spec 2], [spec 10] | Rejected as primary; SwimCloud can change its CSP any time |
| C. Offscreen document, reason `WORKERS` | Yes; one at a time; `runtime` API only | [doc 8] | Fallback only |
| D. Extension page (tab or docked iframe) `new Worker('optimizer.worker.js')` | Yes: same origin, extension CSP, direct IndexedDB, lives as long as the page | [doc 3], [doc 4], [spec 2] | **Primary** |
| E. Content script main thread | Blocks SwimCloud's page; wasm policy unknown | — | Rejected for the MIP; allowed for engine re-scoring (fast, no wasm) |

The docked panel contains the AutoBuilder. The overlay's "AutoBuilder" button
opens the panel on that tab. Collapse hides the iframe with CSS and does not
unmount it while a solve runs. Leaving the page aborts the solve; the result
can be recomputed.

**Overlay ↔ iframe messages.** The content script makes a random nonce and
loads `dashboard.html?host=docked#<nonce>`, then calls
`chrome.runtime.connect({name:'osx-panel:<nonce>'})`. The iframe accepts only
its own name; the SW ignores the `osx-panel:` prefix. Never use
`window.postMessage` here (the page shares the content script's origin and
could forge "save lineup"). Whether `connect` reaches extension iframes is
[unverified]; if not, the SW relays by nonce.

**Decision table on SwimCloud's CSP header** (recon Q19):

| Header | Plan |
| --- | --- |
| none | D, docked iframe |
| present, harness shows the iframe loads | D, docked iframe |
| present, harness shows `frame-src`/`child-src`/`default-src` blocks it | Host the dashboard in `chrome.sidePanel` (extension page, no install warning [doc 5]); run the worker there. Tell the user it sits beside the page, not in it (bends R2). |

**Wasm per context**

| Context | Wasm | Why |
| --- | --- | --- |
| dashboard tab, docked iframe, side panel, offscreen, their workers | yes | `extension_pages` with `'wasm-unsafe-eval'` [doc 3] |
| service worker | forbidden by this spec | 30 s idle and 5 min per-request limits [doc 7]; no `Worker` |
| ISOLATED content script | forbidden | isolated-world CSP undocumented [unverified] |
| MAIN world, blob worker | never | page CSP governs it |

S4 must confirm the HiGHS glue uses no `eval` or `new Function` (T-B7).

**The harness that settles S3:** `tests/extension-harness/s3-workers.spec.ts`,
run by `scripts/run-extension-harness.mjs` (copy the `run-harness.mjs` skip
rules).
- Load `apps/extension/dist` unpacked in Playwright Chromium.
- `context.route('**/*', …)`: fulfill
  `https://www.swimcloud.com/meetsimulator/*` from a committed sanitized
  fixture and **abort every other request**, so nothing reaches swimcloud.com.
- Variant 1: no CSP header. Variant 2: `default-src 'self'; script-src 'self'`.
  Assert: (1) the docked iframe renders; (2) its worker loads `highs.wasm` and
  solves a 2-variable fixture; (3) iframe and tab read the same IndexedDB
  record; (4) the overlay ↔ iframe port delivers a message; (5) the fixture
  page's `document.styleSheets.length` and a SwimCloud element's computed style
  are unchanged by injection.
- Record each result in the state file's S3 entry.

- [spec 10] https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src
- [doc 11] https://developer.chrome.com/docs/extensions/reference/api/runtime

---

## 4. Shadow DOM, light DOM and dark mode

**Light DOM** (plan 3.5): rule dropdowns, tag toggles in SwimCloud tables,
cut and conversion badges, the parity line. They use SwimCloud's own classes
(recon Q15) plus `osx-`-prefixed classes. The only OmniSwim CSS in the page is
`light.css`, scoped to `.osx-*` (T-B9). No custom properties on the page's
`:root`. Light-DOM additions follow SwimCloud's theme, never ours.

**Shadow host** (overlay): a plain `<div data-osx-host>` with
`attachShadow({mode:'open'})` (Playwright cannot pierce `closed`, and `closed`
buys nothing here). It contains the iframe container and small widgets.
React-heavy UI and Recharts live in the iframe.

Traps:
1. **Page rules beat `:host`.** Put layout on the host as inline style
   (`all: initial; position: fixed; z-index: 2147483000`) and reset an inner
   wrapper `.osx-root { all: initial; … }`.
2. **Inherited properties leak in** (font, color, line-height). The wrapper
   reset handles them; `font-family: var(--osx-font)` = SwimCloud's family name.
3. **`@font-face` inside a shadow root does not load.** Ship no fonts; reuse
   SwimCloud's family name.
4. **`rem` follows the page's `html` font-size.** Use `px` or `em`.
5. **Keyboard events are composed** and reach SwimCloud's handlers.
   `stopPropagation()` on `keydown`/`keyup`/`keypress` at the wrapper.
6. **Portals to `document.body` escape the shadow root.** Render popovers inside it.
7. **`customElements` may be unusable in isolated worlds** [unverified]. Define none in a content script.
8. **Iframe background**: set it explicitly; a `color-scheme` mismatch can paint an opaque backdrop [unverified].

**Tokens and dark mode.** `--osx-bg`, `--osx-surface`, `--osx-fg`,
`--osx-fg-muted`, `--osx-border`, `--osx-accent`, `--osx-accent-fg`,
`--osx-good`, `--osx-warn`, `--osx-bad`, `--osx-font`, `--osx-radius`.
- Set on `.osx-root` inside the shadow root and on `:root` of
  `dashboard.html`, selected by `data-osx-theme="light|dark"`. `system`
  resolves with `matchMedia('(prefers-color-scheme: dark)')`.
- Light values come **only** from recon Q15. Until then use CSS system colors
  (`Canvas`, `CanvasText`, `GrayText`, `AccentColor`) with
  `color-scheme: light`. Do not invent SwimCloud's palette.
- Accent: a validated `#rrggbb`; derive the rest with `color-mix()`.
- Light is the default.

---

## 5. D3: IndexedDB schema v1

### 5.1 Library: `idb@8`

Typed `DBSchema` (wrong store or index names fail at compile time), `tx.done`,
and an upgrade callback `(db, oldVersion, newVersion, tx)`, in a thin wrapper.
Raw IndexedDB invites forgotten `onerror` handlers; Dexie is more than we need.
Tests use `fake-indexeddb` with a fresh injected `IDBFactory` per test (not the
global `auto` import).

### 5.2 Types (`apps/extension/src/storage/schema.ts`)

```ts
import type { DBSchema } from 'idb';
import type { RulePreset, SessionPreset, Lineup, Gender } from '@omniswim/engine'; // D2 names

export const DB_NAME = 'omniswim';
export const DB_VERSION = 1;

/** SwimCloud numeric id kept as a string. 123 and '123' are DIFFERENT IndexedDB keys. */
export type SwimCloudId = string & { readonly __brand: 'SwimCloudId' };
export function toSwimCloudId(raw: string): SwimCloudId; // throws unless /^[1-9][0-9]*$/

export type IsoTime = string;            // Date#toISOString(); never a Date
export type Rev = number;                // 1 on create, +1 per write

export type RecordOrigin =
  | { readonly kind: 'local' }
  | { readonly kind: 'imported'; readonly fileName: string; readonly importedAt: IsoTime; readonly exportedAt: IsoTime };

export type PresetRef =
  | { readonly kind: 'builtin'; readonly id: string; readonly version: number }
  | { readonly kind: 'user'; readonly id: string };

interface Versioned<P> { readonly payloadVersion: number; readonly payload: P }
interface Edited { readonly rev: Rev; readonly createdAt: IsoTime; readonly updatedAt: IsoTime }

export interface RulePresetRecord extends Versioned<RulePreset>, Edited {
  readonly id: string; readonly name: string; readonly origin: RecordOrigin;
  readonly derivedFrom?: { readonly builtinId: string; readonly builtinVersion: number };
}
export interface SessionPresetRecord extends Versioned<SessionPreset>, Edited {
  readonly id: string; readonly name: string; readonly origin: RecordOrigin;
  readonly derivedFrom?: { readonly builtinId: string; readonly builtinVersion: number };
}
export interface MeetRecord extends Edited {
  readonly meetKey: string; readonly name: string; readonly gender: Gender;
  readonly teamIds: readonly SwimCloudId[];
  readonly simulatorQuery?: string;                    // observed query string; absent if unknown
  readonly rulePreset: PresetRef; readonly sessionPreset?: PresetRef; readonly origin: RecordOrigin;
}
export interface TagRecord {
  readonly meetKey: string; readonly teamId: SwimCloudId; readonly swimmerId: SwimCloudId;
  readonly role: 'scorer' | 'non-scorer' | 'exhibition';  // no 'auto': auto = no record
  readonly rev: Rev; readonly updatedAt: IsoTime;
}
export interface LineupRecord extends Versioned<Lineup>, Edited {
  readonly lineupId: string; readonly meetKey: string; readonly name: string;
  readonly kind: 'lineup' | 'snapshot';                // snapshot: immutable after create
  readonly parentLineupId?: string; readonly origin: RecordOrigin;
  readonly builtUnder: {
    readonly rulePreset: PresetRef; readonly rulePresetRev?: Rev; readonly rulePresetValues: RulePreset;
    readonly sessionPreset?: PresetRef; readonly sessionPresetRev?: Rev; readonly sessionPresetValues?: SessionPreset;
  };
  readonly results?: unknown;                          // snapshot only; SwimCloud-derived; D2 Results
}
export interface SwimmerHistoryRecord extends Versioned<unknown> {   // payload type fixed in P4
  readonly swimmerId: SwimCloudId; readonly fetchedAt: IsoTime; readonly sourceUrl: string;
  readonly parser: { readonly name: string; readonly confidence: string; readonly warnings: readonly string[] };
}
export interface RosterRecord {
  readonly teamId: SwimCloudId; readonly seasonId: string; readonly gender: Gender;
  readonly memberIds: readonly SwimCloudId[]; readonly sourceUrl: string; readonly fetchedAt: IsoTime;
  readonly parser: { readonly name: string; readonly confidence: string };
}
export interface SettingsMap {
  theme: 'light' | 'dark' | 'system';     // default 'light'
  accent: string;                         // no default; absent = SwimCloud-sampled accent
  cutCloseThresholdPct: number;           // default 1.0 (R11, user-stated)
  flyoverAllowanceSec: number;            // NO default (R14). Absent until the user sets it.
  fetchPosture: 'off' | 'on-click';       // default 'off' (R7: extra fetches not approved)
}
export interface SettingRecord<K extends keyof SettingsMap = keyof SettingsMap> {
  readonly key: K; readonly value: SettingsMap[K]; readonly rev: Rev; readonly updatedAt: IsoTime;
}

export interface OmniDbSchema extends DBSchema {
  meta:           { key: string; value: { key: string; [k: string]: unknown } };
  settings:       { key: keyof SettingsMap; value: SettingRecord };
  rulePresets:    { key: string; value: RulePresetRecord;    indexes: { byName: string } };
  sessionPresets: { key: string; value: SessionPresetRecord; indexes: { byName: string } };
  meets:          { key: string; value: MeetRecord;          indexes: { byUpdatedAt: string } };
  tags:           { key: [string, string, string]; value: TagRecord; indexes: { byMeet: string } };
  lineups:        { key: string; value: LineupRecord;        indexes: { byMeet: string; byUpdatedAt: string } };
  swimmerHistory: { key: string; value: SwimmerHistoryRecord; indexes: { byFetchedAt: string } };
  rosters:        { key: [string, string, string]; value: RosterRecord; indexes: { byFetchedAt: string } };
}
```

- `tags` key path `['meetKey','teamId','swimmerId']`; `rosters`
  `['teamId','seasonId','gender']`. Array keys, not `'a:b:c'` strings.
- `meta` holds `{key:'db', schemaVersion, createdAt, installId, migrationLog:[{from,to,at}]}`
  and `{key:'changeRev', value:number}`. `installId` is a random UUID that never
  leaves the browser. IDs come from `crypto.randomUUID()`.
- `SETTINGS_DEFAULTS` lives in code, with every key except
  `flyoverAllowanceSec` and `accent`. Defaults are never written at install.
  A missing setting reads as its default where one exists, else `undefined`.

### 5.3 Who writes, and how contexts stay consistent

| Writer | Stores | Path |
| --- | --- | --- |
| dashboard (tab or iframe) | all except `meta` | `StorageRepo` directly |
| `sim-overlay` (page tags, R16 schedule edits, lineups) | all except `meta` | message to the SW → `StorageRepo` |
| service worker | brokered writes; `swimmerHistory` and `rosters` from content-script fetch results | `StorageRepo` |
| `optimizer.worker` | none (inputs and results by message) | — |

```ts
// apps/extension/src/storage/repo.ts
export function openOmniDb(opts?: { factory?: IDBFactory; migrations?: readonly Migration[]; version?: number;
  onVersionChange?: () => void }): Promise<IDBPDatabase<OmniDbSchema>>;
export class StaleWriteError extends Error { constructor(readonly store: string, readonly key: unknown) }
export class NewerDatabaseError extends Error {}
export interface StorageRepo {
  get<S extends UserStore>(store: S, key: KeyOf<S>): Promise<{ found: false } | { found: true; value: ValueOf<S> }>;
  list<S extends UserStore>(store: S, query?: { index: IndexOf<S>; value: IDBValidKey }): Promise<ValueOf<S>[]>;
  put<S extends EditedStore>(store: S, record: Omit<ValueOf<S>, 'rev'|'updatedAt'>, expectedRev: Rev | 'new'): Promise<ValueOf<S>>;
  delete<S extends EditedStore>(store: S, key: KeyOf<S>, expectedRev: Rev): Promise<void>;
  putCache<S extends 'swimmerHistory'|'rosters'>(store: S, record: ValueOf<S>): Promise<void>; // no rev
}
// UserStore = every store except 'meta'. EditedStore = UserStore minus swimmerHistory, rosters.
```

Rules:
1. **Read-modify-write in one readwrite transaction**, awaiting only IndexedDB
   promises inside it (anything else auto-commits the transaction).
2. **Optimistic concurrency.** `put` reads the current record in the same
   transaction. `'new'` over an existing record, or a `rev` mismatch, throws
   `StaleWriteError`; otherwise write with `rev + 1`. The UI reloads and shows
   "changed elsewhere".
3. **Change bus.** Every write transaction bumps `meta.changeRev`. After
   `await tx.done`, `chrome.storage.local.set({'osx:change': {rev, stores, at}})`.
   Surfaces listen on `chrome.storage.onChanged` and also compare `changeRev`
   on `visibilitychange` and `focus` (a lost notice is not data loss). The bus
   is an injected interface so tests run without `chrome`.
4. **Broker messages**
   `{type:'osx/storage', op:'get'|'list'|'put'|'delete', store, key?, query?, record?, expectedRev?}`;
   reply `{ok:true, found?, value?} | {ok:false, error:{code:'stale'|'invalid'|'denied'|'internal'|'context-invalidated', message}}`.
   The SW validates every `record` with the import zod schemas (content scripts
   are less trusted) and refuses `meta`. Copy the latched `sendResponse`
   dispatcher pattern from legacy `background.ts:500-546`; do not import legacy.
5. **Records are JSON-safe**: ISO strings, no `Map`/`Set`, no
   `undefined`-valued keys. `{found:false}` stays distinct from a found record.
6. **Extension update.** Orphaned content scripts throw "Extension context
   invalidated". The broker returns `context-invalidated` (never hangs); the
   overlay shows "OmniSwim was updated. Reload this page." and stops writing.

### 5.4 Absent is not empty (provenance rules 2 to 4)

| Input | Must give | Never |
| --- | --- | --- |
| Swimmer never fetched | no `swimmerHistory` record → `{found:false}` | a record with an empty payload |
| Fetch failed (403, 429 after retries, parse error) | **no write** | an empty history cached |
| Roster season not fetched | no `rosters` record → membership `unknown` | `memberIds: []` |
| No tag | no `tags` record → role "auto" | `role: 'non-scorer'` |
| Flyover never set | `{found:false}`; engine shows "no split" | 0 |
| Preset cap unlimited | `'unlimited'` | 999, `null`, missing |
| Preset cap missing on put or import | rejected `invalid` | treated as unlimited |
| Provenance `'legacy'` | rejected | — |

### 5.5 Versions and migrations

Two axes, both migrated eagerly in one ordered chain inside the versionchange
transaction: `DB_VERSION` (stores and indexes) and `payloadVersion` per record
(D2 type shapes).

```ts
// apps/extension/src/storage/migrations.ts
export interface Migration {
  readonly to: number;
  readonly up: (db: IDBPDatabase<unknown>, tx: IDBPTransaction<unknown, string[], 'versionchange'>) => Promise<void> | void;
}
export const MIGRATIONS: readonly Migration[] = [{ to: 1, up: createV1Stores }];
// openDB(DB_NAME, version, { upgrade(db, old, nw, tx) { for (m of migrations) if (m.to > old && m.to <= nw!) await m.up(db, tx) },
//   blocked: () => surface 'close other OmniSwim tabs', blocking: () => { db.close(); onVersionChange?.() } })
```

`up` awaits only IndexedDB requests on `tx`, is a pure transform (no network,
no `chrome.*`), and is never caught (a failed upgrade aborts and the old data
survives). **Never call `deleteDatabase`** to recover from an open error.

Tests (`tests/extensionStorageMigrations.test.ts`):
- T-M1 `MIGRATIONS.map(m => m.to)` deep-equals `[1..DB_VERSION]`.
- T-M2 For each v, `tests/fixtures/extension-db/v{v}.json` exists and its
  sha256 matches `FROZEN.json`; fixture count equals `DB_VERSION`. Shipped
  fixtures are never edited.
- T-M3 For each v: build a DB at v with `migrations.slice(0, v)` and raw puts of
  the fixture; open with current code; the dump deep-equals
  `v{v}.expected-current.json`.
- T-M4 A DB at `DB_VERSION + 1` rejects with `NewerDatabaseError`; its data
  survives a test-only newer reopen.
- T-M5 Connection A open at v1; B opens v2 with a test migration; B resolves
  and A's `onVersionChange` ran (removing `blocking` makes this time out).
- T-M6 A throwing migration leaves the DB at its old version, data unchanged.

### 5.6 Export and import

```ts
export interface OmniSwimExportV1 {
  readonly format: 'omniswim-export';
  readonly formatVersion: 1;
  readonly exportedAt: IsoTime;
  readonly extensionVersion: string;
  readonly dbSchemaVersion: number;
  readonly includesSwimCloudData: boolean;
  readonly stores: {
    readonly rulePresets?: readonly RulePresetRecord[];
    readonly sessionPresets?: readonly SessionPresetRecord[];
    readonly meets?: readonly MeetRecord[];
    readonly tags?: readonly TagRecord[];
    readonly lineups?: readonly LineupRecord[];
    readonly settings?: readonly SettingRecord[];             // only with "include my settings"
    readonly swimmerHistory?: readonly SwimmerHistoryRecord[]; // only if includesSwimCloudData
    readonly rosters?: readonly RosterRecord[];               // only if includesSwimCloudData
  };
}
export function exportData(repo: StorageRepo, opts: { stores: readonly ExportableStore[]; includeSwimCloudData: boolean; includeSettings: boolean }): Promise<OmniSwimExportV1>;
export function importData(db: IDBPDatabase<OmniDbSchema>, file: unknown, opts: { fileName: string; onConflict: 'keep-both' | 'replace' | 'skip' }): Promise<ImportReport>;
```

**"SwimCloud data"** = swim times and histories, rosters, SwimCloud's scores,
snapshot `results`, swimmer and team display names. **The default export
carries IDs only** (`SwimCloudId`s, events, roles); names resolve from the
simulator page on import. D2's `Lineup` keeps names and times in an optional
`display` subobject so `stripSwimCloudData()` can remove them.

Import rules:
1. A newer `formatVersion` is rejected (`NewerExportError`); an older one runs
   the export-migration chain.
2. `includesSwimCloudData:false` with any `swimmerHistory`, `rosters`,
   `results` or `display` present: reject the file.
3. Validate every record with the broker's zod schemas. **Never fill a missing
   field with a default.** Reject the whole file and list the JSON paths.
4. **Provenance is never upgraded.** A `published` value whose source ID is not
   in a bundled `data/**/sources/manifest.json` is rejected (any source
   manifest, not only the cutlines one; D2 finding F14). Records get
   `origin: {kind:'imported', …}`, `rev: 1`, `updatedAt: now`.
5. `keep-both` gives a conflicting ID a new UUID and **remaps every reference
   in the same file** (`meets.rulePreset`, `meets.sessionPreset`,
   `tags.meetKey`, `lineups.meetKey`, `lineups.builtUnder.*`, `parentLineupId`).
6. One readwrite transaction across all stores: all or nothing.

Tests (`tests/extensionStorageExport.test.ts`):
- T-E1 Round trip with `includeSwimCloudData:true`: export, import into empty,
  export again; equal ignoring `exportedAt`, `origin`, `rev`, `updatedAt`.
  Absent `flyoverAllowanceSec` stays absent; `'unlimited'` stays a string.
- T-E2 The default export has no `swimmerHistory`, `rosters`, `results` or `display`.
- T-E3 One invalid record in the last store: nothing imports.
- T-E4 `keep-both` remaps a conflicting preset ID; no dangling references.
- T-E5 Missing cap, `provenance:'legacy'`, unknown `published` source: rejected.
- T-E6 Every record type survives `JSON.parse(JSON.stringify(r))` unchanged.
- T-E7 A snapshot rejects any `put` after create.
- T-E8 `toSwimCloudId(123 as any)` and `toSwimCloudId('0123')` throw.

### 5.7 Quota and eviction

- Without `unlimitedStorage`, IndexedDB is best-effort and can be evicted.
  `unlimitedStorage` "exempts extensions from both quota restrictions and
  eviction", covers IndexedDB, and has no install warning [doc 1, doc 5].
- Extension storage "is not cleared when a user clears browsing data" [doc 1].
- Uninstall removes the data. An ID change (unpacked folder move without
  `key`) orphans it; `key` prevents that.
- Settings shows `navigator.storage.estimate()` and "clear cache", which
  deletes `swimmerHistory` and `rosters` by age (`byFetchedAt`) and never
  touches user stores.
- After any schema bump, show a one-time "export a backup" prompt.

### 5.8 Built-in presets

NSISC and generic ship as code (`PresetRef {kind:'builtin', id, version}`),
never seeded into IndexedDB; otherwise the P3 fix to NSISC's table would never
reach existing installs. A user copy records `derivedFrom`; when the built-in's
`version` is newer, the UI shows "based on NSISC v1; v2 available" with a diff.
T-P1: on a fresh DB, `list('rulePresets')` is empty and the picker still
offers NSISC.

---

## 6. Scope for the executor

May touch: `apps/extension/**` (new); `tests/extensionBuildFreshness.test.ts`;
`tests/extensionBundleBoundaries.test.ts`; `tests/extensionStorage*.test.ts`;
`tests/fixtures/extension-db/**`; `tests/extension-harness/**`;
`scripts/run-extension-harness.mjs`; root `package.json` scripts
(`build:extension`, `dev:extension`, `test:extension-harness`); `.gitignore`
(`apps/extension/dist/`); `.github/workflows/ci.yml` (build before test;
harness step).

Must not touch: `packages/engine` (D2), `packages/core`, `packages/swimcloud`
(its browser entry belongs to P1.engine), `legacy/**`, `data/**`, `plans/**`.

Order:
1. Build skeleton and T-B1 to T-B9, after P1.reorg lands (paths move).
2. Storage with T-M and T-E, against D2's type names.
3. The S3 harness, after S4 provides `highs.wasm`.
4. Shadow host and tokens.

Run targeted tests while iterating; full gates once at the end; report the
final exports and signatures.

---

## 7. Recon additions (copied into `02-SIMULATOR-RECON.md`)

- **Q19** The `Content-Security-Policy` header on `/meetsimulator/`.
- **Q20** Does `swimcloud.com` (no `www`) redirect to `www`? Decides the
  `matches` patterns.
- **Q21** Does the page load its data in a page worker or service worker?

---

## 8. Not verified in the docs (the S3 harness settles each)

- Whether WebAssembly is allowed in a content script's isolated world.
- Whether SwimCloud's CSP can block an extension iframe.
- Whether `runtime.connect` from a content script reaches an extension iframe.
- Whether `customElements` is unusable in isolated worlds.
- The Chrome version for the manifest `world` key.

---

## 9. Where this spec changed the plan

1. **Plan 3.2/3.5 assumed the on-page dashboard could use storage and workers
   directly.** Mounted in a shadow root on the page, it would run as
   swimcloud.com and open SwimCloud's IndexedDB: saves would look fine but
   never reach the dashboard tab, and SwimCloud's scripts could read them. The
   docked panel is now an extension-page iframe (0.3), and T-B6 keeps
   `indexedDB` out of content-script bundles.
2. **No offscreen document in v1.** The AutoBuilder runs in the docked panel or
   the tab, so an extension page always hosts the worker. Offscreen is fallback C.
3. **The fetch queue stays in the content script**, not the SW. Legacy crawl ran
   same-origin in the content script (`crawlLock.ts:8-10`); SW requests have
   different Origin and cookie behavior, and the SW stops after 30 s idle, which
   can cut off a 3 s-paced queue. Not blocking: the F1.1 fallback is not approved.
4. **A `meets` store** was missing; tags and lineups key on `meetKey`. Text keys
   like `teamId:season:gender` became array keys.
5. **Installed packages in the main clone did not match `package.json`** on
   2026-10-25 (vite 6.4.3 vs `^8.3.4`, esbuild 0.25.12 vs `^0.28.2`, vitest 3.2.6
   vs `4.1.12`, `@vitejs/plugin-react` 5.2.0 vs `^6.1.2`). The next `npm ci`
   changes all four. The extension pins esbuild exactly (T-B4).
6. **Built bundles are not committed** (2.4).
7. **No Tailwind in the extension** (2.1 item 6).
8. **D2 must give `Lineup` a strippable `display` subobject** for the IDs-only
   default export (5.6).
9. **Side panel is the fallback host** if SwimCloud's CSP blocks the iframe.
   It bends R2 (beside the page, not in it); tell the user before switching.
