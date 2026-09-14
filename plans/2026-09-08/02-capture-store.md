# The capture store

## It is the existing cache, extended — not a second format

`packages/swimcloud/src/cache.ts` already defines `SwimCloudCacheStore` and
`FileSystemSwimCloudCache`, with the `'final'`-is-immutable semantics this
crawl needs and `SwimCloudPoliteFetcher` already enforcing them. It is used
only by tests today — nothing in the app wires it up — so there is no
existing on-disk location to reconcile with, and no migration.

**Decision: the capture store is `FileSystemSwimCloudCache` for page bytes,
plus a new manifest layer above it.** Inventing a second filesystem format
would put two page stores in one package with different immutability rules.

## Layout

```
<captureRoot>/
  index.json                # derived manifest the Matrix picker lists
  captures/
    meet-356467.json        # one capture record per subject
    team-58.json
  pages/
    <fileNameFor(canonicalUrl)>.json   # unchanged FileSystemSwimCloudCache format
```

`pages/` is byte-for-byte today's format. `FileSystemSwimCloudCache` is
constructed with `<captureRoot>/pages`; not one line of it changes.

`index.json` is **derived and rebuildable** from `captures/*.json`. If it
disagrees with them, it is rebuilt, and the disagreement is logged. It is a
read cache, never a source of truth.

## Format: raw HTML, not pre-parsed JSON

Three of four parsers in this package are unverified, and the fourth is
verified against exactly one page. Pre-parsing at capture time freezes
today's parser into the archive permanently. Raw HTML lets a later parser
fix retroactively improve every capture already taken — which matters most
for precisely the pages whose markup nobody has seen yet. Re-parsing 64
pages of pure regex extraction costs milliseconds.

The store therefore holds HTML only. Parsing happens on import (see
[05-matrix-import-ui.md](05-matrix-import-ui.md)).

## New types (new module `packages/swimcloud/src/captureStore.ts`)

```ts
type SwimCloudCaptureSubject =
  | { kind: 'meet'; meetId: SwimCloudMeetId }
  | { kind: 'team'; teamId: SwimCloudTeamId; season?: string };

type SwimCloudCapturePageOutcome = 'ok' | 'http-error' | 'forbidden' | 'skipped' | 'canceled';

interface SwimCloudCapturePageRef {
  canonicalUrl: string;        // the cache key — urlClassifier's canonicalUrl
  resourceKind: SwimCloudResourceKind;
  meetId?: SwimCloudMeetId;
  teamId?: SwimCloudTeamId;
  gender?: string;
  page?: number;
  retrievedAt: string;         // ISO-8601
  httpStatus?: number;
  sha256?: string;             // over the raw HTML, computed by the writer
  bytes?: number;
  cacheStatus: 'provisional' | 'final';
  outcome: SwimCloudCapturePageOutcome;
  detail?: string;             // present iff outcome !== 'ok'
}

type SwimCloudCaptureCompleteness =
  | 'in-progress'
  | 'every-planned-page-fetched'   // strongest claim available
  | 'partial'                      // some planned page failed or was canceled
  | 'failed';

interface SwimCloudCaptureRecord {
  captureId: string;           // 'meet-356467' | 'team-58-2026-2027'
  subject: SwimCloudCaptureSubject;
  label?: string;               // meet name / team name, as printed
  createdAt: string;
  updatedAt: string;
  track: SwimCloudCaptureTrack; // 'browser-extension'
  completeness: SwimCloudCaptureCompleteness;
  teamDiscovery?: {
    source: 'meet-root-links';
    genders: readonly string[];
    teamIds: readonly string[];
    completeness: 'unproven' | 'user-confirmed';
  };
  plannedPageCount: number;
  pages: readonly SwimCloudCapturePageRef[];
  notes: readonly string[];
}
```

Note what is **not** in the enum: there is no `'complete'`. The strongest
value is `'every-planned-page-fetched'`, which is a claim about the plan,
not about SwimCloud. That is `CLAUDE.md` rule 4 (absent ≠ empty) applied to
a capture: a complete-looking capture of a truncated team list is not
distinguishable from a genuinely complete one, so the type refuses to say.

## Additive changes to existing types

`SwimCloudCacheEntry` gains two optional fields: `httpStatus?: number` and
`captureId?: string`. Both optional, so every existing caller and test
compiles unchanged.

## Merge and re-capture semantics

Mirrors `mergeSwimCloudResults` in
`packages/matrix/src/lib/swimCloudMeetImportBridge.ts` deliberately, rather
than inventing a convention:

- **Pages merge by `canonicalUrl`** — the same key `FileSystemSwimCloudCache`
  already uses. Existing entries keep their position; new ones append; a
  re-captured URL replaces its predecessor. That is `mergeSwimCloudResults`'s
  exact shape, one level up.
- **Captures merge by `captureId`**, derived from the subject. Re-capturing
  meet 356467 updates `captures/meet-356467.json` in place. `createdAt` is
  preserved; `updatedAt` moves.
- **`'final'` pages are never re-fetched.** `SwimCloudPoliteFetcher` already
  throws `SwimCloudFinalEntryImmutableError` on `forceRefresh`, and the
  store does not weaken that. To genuinely re-capture a finished meet,
  delete its pages first — a separate, visible action, exposed in the
  Matrix picker as "Forget this capture."
- **A page is marked `'final'` only when the meet page prints**
  `<li id="meet-status">Completed</li>` — a value present in all three real
  fixtures. It is read, never inferred. An in-progress meet's pages stay
  `'provisional'` and remain re-fetchable, which is what `cache.ts`'s
  header describes.

## Store API

`FileSystemSwimCloudCaptureStore` (new class, same file), constructed with a
root path:

```ts
getCapture(captureId: string): SwimCloudCaptureRecord | undefined;
listCaptures(): readonly SwimCloudCaptureRecord[];
upsertCapture(record: SwimCloudCaptureRecord): SwimCloudCaptureRecord;
putPage(captureId: string, entry: SwimCloudCacheEntry, pageRef: SwimCloudCapturePageRef): void;
readPage(canonicalUrl: string): SwimCloudCacheEntry | undefined;
deleteCapture(captureId: string, options: { withPages: boolean }): void;
rebuildIndex(): void;
```

It composes `FileSystemSwimCloudCache` rather than reimplementing it, and it
never writes `pages/` directly.
