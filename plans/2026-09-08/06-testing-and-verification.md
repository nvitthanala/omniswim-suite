# Testing and verification

## Real fixtures needed — each is one human, one browser, one click

None of these exist. Every one blocks something.

| # | Page | Unblocks | Priority |
| --- | --- | --- | --- |
| F1 | ✅ **Captured 2026-09-08.** A large meet root (13 teams, meet 379295 MPSF), `?gender=M` and `?gender=F` — `tests/fixtures/swimcloud-real-meet-landing-379295-gender-{m,f}.html`. Confirmed: the Teams card truncates and links to a new `topteams` resource. | **OQ-1 — resolved.** Also confirmed the High point / Performances "More"-link pattern reproduces on a second, larger meet. | Done |
| F1b | ✅ **Captured 2026-09-08.** `/results/379295/topteams/?gender=M` and `?gender=F` — `tests/fixtures/swimcloud-real-meet-topteams-379295-gender-{m,f}.html`. Confirmed: all 13 teams present, zero-score teams shown not omitted. | **OQ-1b — resolved.** `parseMeetTopTeamsHtml` is buildable now, `real-capture-verified`. | Done |
| F2 | `/results/356467/?gender=F` | Do the cards differ by gender? | Superseded by F1's `-gender-f` capture on a different meet — low priority now |
| F3 | Swims list page **2** and page **8** (last) | Pagination mid/last shape; is `nextPageHref` absent on the last page? | High |
| F4 | Swims list `?gender=F` page 1 | The women's branch, never seen | High |
| F5 | A team+gender with only **one** page | The absent-pagination branch on real markup | Medium |
| F6 | `/team/58/roster/` | `parseTeamRosterHtml` | Blocks team scope |
| F7 | `/swimmer/{id}/` | `parseSwimmerProfileHtml` | Blocks team scope |
| F8 | `/team/58/results/` and `/team/58/results/?year=…` | **OQ-2**, the season definition | Blocks team scope |
| F9 | `/results/356467/event/{n}/` | Where DQs live. Out of scope; capture opportunistically | Low |

Archive them under `tests/fixtures/swimcloud-real-*.html`, following the
existing convention exactly: a header comment stating source URL, capture
date, what was trimmed, what PII was removed, and — the part that makes
these fixtures unusually valuable — **the finding the fixture proves**.

## Unit tests

- **Crawl planner** (pure, no network): given F1 + a page-1 parse, emits
  the exact expected URL list; never emits a non-`meetTeamSwims` URL for
  the meet subject; stops at `totalPages`; produces zero URLs for a
  `forbidden` or `malformed` input. Include a deliberately-denylisted input
  and assert the planner refuses.
- **`parseMeetTeamsHtml`** against the existing real landing fixture and
  against F1: the union across genders; `discoveryCompleteness` is always
  `'unproven'`.
- **Capture store**: page merge by `canonicalUrl` mirrors
  `mergeSwimCloudResults`'s semantics (existing keep position, new append,
  re-capture replaces); re-capture updates `updatedAt` and preserves
  `createdAt`; `'final'` immutability holds through the store; `index.json`
  rebuilds correctly from `captures/`; a corrupt `index.json` triggers a
  rebuild rather than a wrong list.
- **Politeness through the bundle**: reuse `tests/swimcloudFetcher.test.ts`'s
  injected-clock pattern against the browser bundle's entry, so the
  guarantee is proven for the code that actually ships to the extension,
  not only for the source.
- **Bundle freshness**: rebuild `vendor/omniswim-swimcloud.js` in the test
  and assert it matches the committed file. This is the guard against the
  drift `content.js`'s hand-duplicated payload shape is currently exposed
  to.
- **Server route**: rejects a missing or wrong token; refuses to register
  when `HOST` is non-loopback; rejects a `captureId` that resolves outside
  the capture root; rejects an oversized body.
- **Regression**: the existing meet-import tests keep passing unchanged,
  because the bridge is untouched. That is the acceptance signal that this
  round did not disturb the verified path.

Follow `plans/2026-08-16/README.md` rule 3: every new guard gets a
deliberate mutation and is seen to fail before the mutation is reverted.

## Manual verification checklist

In the style of `plans/2026-09-06/verification-screenshots/`, with
screenshots saved to `plans/2026-09-08/verification-screenshots/`:

1. `crawl-confirm-dialog.png` — the discovered-teams checklist and the
   stated page count and time estimate, before any bulk fetching.
2. `crawl-in-progress.png` — the panel mid-crawl, determinate progress.
3. `crawl-canceled-partial.png` — cancel mid-crawl; the capture is
   `'partial'` and pages already fetched survive.
4. `crawl-403-stop.png` — a challenge stops the crawl with the resume
   message and **no retry loop** in the network log.
5. `capture-store-on-disk.png` — the real directory, showing `index.json`,
   `captures/`, `pages/`.
6. `matrix-capture-picker.png` — the picker listing the capture, with the
   completeness string reading "team list unverified."
7. `matrix-after-store-import.png` — Matrix after import showing
   **"SUGGESTED PRESET: nsisc"** and **"PDF PLACE POINTS: AUTO,"** the same
   state `WORKLOG-03` verified for the clipboard path. This is the proof
   the pipeline is genuinely unchanged.
8. `recapture-idempotent.png` — re-running the same crawl; row count is
   unchanged, not doubled.

`WORKLOG-03` records that clicking through the real app caught two bugs
that 231 unit tests did not (duplicate React keys; `pdfFilename` read as
the global "what's loaded" label in seven places). Steps 6–8 exist because
of that history.
