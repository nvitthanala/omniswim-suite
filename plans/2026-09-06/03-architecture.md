# Architecture

## 1. New package: `packages/swimcloud`

Owns everything specific to SwimCloud as a source, kept separate from the
domain model in `packages/core` and persistence in `packages/db` so the
domain layer never knows or cares where an Entry/Result came from. Four
pieces, each independently testable:

1. **URL classifier** — pure function, `string -> { kind: 'team' | 'swimmer'
   | 'meet' | 'meetEvent' | 'conference', id | slug }` against the patterns
   in [02](02-data-model-and-scoring.md) §1, or a typed error for anything
   else (never a silent guess). Testable with zero network access.
2. **Politeness-enforcing fetcher wrapper** — the single choke point every
   request from either access track must pass through:
   - Hard-rejects the robots.txt denylist (`/api/`, `/jsonapi/`,
     `/team/*/facilities/`, `/tz_detect/`) before issuing anything — enforced
     in code, not just in [01](01-legal-and-access-strategy.md).
   - Enforces a minimum delay between requests (seconds, not milliseconds);
     no concurrency.
   - Sends an honest, identifying User-Agent — no browser impersonation.
   - Every successful fetch writes through the cache (§3) before returning.
3. **Parser/normalizer** — DOM (or extension-extracted JSON) in, typed
   entities out (§ Entities in
   [02](02-data-model-and-scoring.md)). **This is the one piece shared by
   both access tracks** — Track A's extension and Track B's Playwright
   fetcher both hand it a rendered DOM; it has no idea which track produced
   it. This is deliberate: it's the only way to keep the two tracks from
   silently drifting into different field coverage over time.
4. **Status-keyed cache** — raw snapshot store, keyed by URL, tagged
   `provisional` or `final` at write time. `final` pages (a meet whose
   results are posted complete) are treated as immutable and never
   re-fetched. `provisional` pages (a meet still in progress) are the only
   ones eligible for a manual re-fetch. This directly implements the
   "snapshot final results once, keep polling in-progress meets" requirement
   — no prior-art source solved this exact problem for live sports pages
   (checked), so this is a synthesis of the general idempotent-URL-cache
   pattern applied to this domain, not an imported design.

Persists through `packages/db` using the same store already backing
`historyImportRoster.ts`, extended with the new entity tables from
[02](02-data-model-and-scoring.md) §2 — not a parallel database.

## 2. Track A: browser extension (`extensions/swimcloud-companion/`)

New top-level directory, separate from `packages/*` — it ships to a browser,
not to the Node/Tauri app.

- Manifest V3, content script injected on `swimcloud.com/{team,swimmer,
  results,country}/...` pages only.
- Adds a single "Import to Omniswim" button/panel on pages it recognizes
  (reuses the URL classifier's *shape*, duplicated as a lightweight
  client-side check — the extension can't import a Node package directly,
  but the pattern list is small and should be kept in sync by a shared
  fixture test, not by hand).
- On click: extracts the already-rendered DOM into the same JSON shape the
  parser/normalizer (§1.3) expects, and posts it to a localhost endpoint the
  desktop app exposes while running (see §4 — open question on transport).
- Does **not** navigate anywhere on its own, does **not** run on a timer,
  does **not** act without the click. This is the entire basis for Track A's
  different risk posture in [01](01-legal-and-access-strategy.md) — an
  implementation that added a "auto-import every page I visit" toggle would
  quietly turn this into Track B and needs to be treated that way if ever
  proposed.

## 3. Track B: automated fetch service

Lives inside `packages/swimcloud`, not a separate package — it's the fetcher
wrapper (§1.2) driven by Playwright instead of the extension:

- Playwright headless, real Chromium — required to pass the Cloudflare
  Managed Challenge (plain HTTP cannot, per
  [01](01-legal-and-access-strategy.md) §2).
- `storageState()` session reuse across runs — warm up a context once,
  persist cookies locally (outside version control), rehydrate on
  subsequent fetches instead of re-solving a challenge every time. Reduces
  both friction and request volume, which also serves the politeness
  constraints in [01](01-legal-and-access-strategy.md) §4.
- Fires only on an explicit "fetch this link" action in the paste-import UI
  (§4) — never on a schedule, never in the background, per the recorded
  on-demand-only decision.
- Everything else (denylist, rate limit, cache, honest UA) is the shared
  wrapper from §1.2 — Track B gets no special exemption from those.

## 4. Wiring into existing import UX

Extends `RosterImportWizard` / `AthleteHistoryImportPanel` (the paste-preset
flow from Round 3 — `docs/archive/2026-08/ROSTER_ALIAS_DECLUTTER_HANDOFF.md`)
rather than adding a parallel import path:

- A "Paste a SwimCloud link" input alongside the existing paste-text flow.
- On paste: run the URL classifier (§1.1). If unrecognized, surface a clear
  error, never a silent no-op.
- If recognized: the UI shows both tracks as distinct, visible choices —
  "Import via browser extension" (if installed and the page has already been
  captured) vs. "Fetch automatically now" (Track B, with a persistent, can't
  -miss-it indicator that this path knowingly runs outside SwimCloud's
  Terms — not a one-time dialog the user clicks past once). This is a UI
  requirement, not a footnote: the choice of track needs to stay visible
  every time, since it's the thing that was explicitly negotiated with the
  user rather than defaulted.
- Either track's output lands in the exact same place: the parser/normalizer
  output feeds the existing **Parse → checkbox preview list → "Add
  selected"/"Cancel"** UX already built for lineup paste (Round 3) — existing
  entries stay editable throughout, nothing auto-applies.
- New-row alias suggestions (an imported athlete who might already be on the
  roster under a different name) route through the existing
  `suggestAliasCandidates`, same as any other import source — no new aliasing
  mechanism.

## 5. Open transport question (Track A → app)

How the extension's extracted JSON reaches the desktop app is not yet
decided — candidates: (a) a localhost HTTP endpoint the Tauri backend exposes
only while the app is running, (b) the extension writes to a watched local
file, (c) copy-to-clipboard + an "Import from clipboard" button in-app (no
new transport at all, but an extra manual step per import). Recorded as an
open question in [04](04-phasing.md), not resolved here — needs a decision
before Track A implementation starts.
