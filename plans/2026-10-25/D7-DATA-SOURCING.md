# D7: Data sourcing (phase P4) build spec

Status: spec, 2026-11-05. Author: architect (read-only); written in by the
lead after spot-checking its citations (results.ts:433 and :449,
convert.ts:127, schema.ts:177 and :203, squads.ts:84, recon item 8).
Builders: `executor` for core, `worker` for controls.

Inputs: 01-REDESIGN-PLAN.md F1; README R7, R10, R14, R51, R53, R58, R61 to
R63, R84 to R89; 02-SIMULATOR-RECON.md items 5 to 9 and "P4 recon,
2026-11-05"; D2 3.6, 3.10, 3.13; D3 5.3, 5.4, 9, 14.

## 0. Findings that change the plan

| # | Finding | Evidence | Effect |
|---|---|---|---|
| 1 | The approved LCM route probably returns nothing. The team endpoint returns only swims recorded for that team. | recon item 8: team 58, season 2025-26 (includes summer 2026), `eventcourse=L`: 42 swimmers, 0 rows. | F1.2 is built as approved (R84). For most teams the honest result is "SwimCloud lists no LCM swims for this team". Cross-team LCM swims need a per-swimmer endpoint (U1). |
| 2 | SwimCloud shows no converted times. | recon item 8 | R10 step 1 never fires. The F1.2 fixture "SCM with a SwimCloud conversion" cannot be captured, and SCM fetches are not approved. Section 6 rewrites the acceptance. |
| 3 | An LCM 400, 800 or 1500 free swim has two event keys, and the code uses both. | convert.ts:127 converts the key it gets against the preset's `lcmEventKey` (builtins.ts:176-178). validate.ts:419-423 needs the swim's key in the meet's events, which are yards only (adapt.ts:215-216). results.ts:395 seeds by equal key. cutTag.ts:214-229 judges the own course with `swim.eventKey`. | Decision K. |
| 4 | A wider window adds only same-team swims of current-roster swimmers. Nothing for transfers or robust mode. | recon items 6 and P4 recon. Rows carry no date (recon item 5). Robust mode needs dated swims (D5:671). | F1.1 stays last. The "extended window" badge is a diff (section 7). R85's robust-mode use needs `times_by_event` (U3). |
| 5 | A past roster season can only narrow the field. | recon item 6. adapt.ts:193-195 marks every listed swimmer a member. | Former members have no swims in the model. They show as a count, never as entries. |
| 6 | Nothing writes `rosters` or `swimmerHistory`, and the service worker has no storage broker. | sw/main.ts:14-21, overlay.ts:8-11 | Decision W. |
| 7 | Three scoring sites pass literal sourcing settings. | scorerTagScoring.ts:88, suggestedRosters.ts:31, rescore.ts:21 | Decision L. |
| 8 | Archived captures mostly close the roster gender gap. | `tests/fixtures/swimcloud-real-team-roster-58-gender-m.html` has `name="gender" value="M" checked` and heading "Season 2025-2026 Men"; rosterPage.ts:516-534 cross-checks them; crawlPlan.ts:93-99 builds both roster URLs. The empty-state fixture `tests/fixtures/swimcloud/team-10002824-roster-gender-M-page.html` has the season select (`29 selected`) but no gender radio. | On an empty page, gender comes from the request. One live confirmation is enough. |
| 9 | Scoring throws on both P4 leg kinds today. | results.ts:433 (`flyover-estimate`), results.ts:449-450 (`split_not_scy`); squads.ts:84 skips non-SCY splits. | F1.3a fixes both in the engine. |

## 1. Scope

| May touch | Must not touch |
|---|---|
| `apps/extension/src/shared/{fetchProtocol.ts (new), panelProtocol.ts, bridgeSchema.ts, protocol.ts}` | `DB_VERSION`, `storage/migrations.ts`, `storage/repo.ts` |
| `apps/extension/src/bridge/install.ts` (seasonchoices capture only) | `tests/fixtures/extension-db/**`, `FROZEN.json` |
| `apps/extension/src/overlay/{fetchQueue.ts (new), overlay.ts, dockedPanel.ts}` | `packages/engine/src/lib/**` |
| `apps/extension/src/dashboard/{liveModel.ts, fetchClient.ts (new), autoBuilderRequest.ts, scorerTagScoring.ts, suggestedRosters.ts}` and UI files (worker) | `legacy/**`: copy constants with a citation, do not import |
| `apps/extension/src/storage/schema.ts` and `validate.ts`: new `SettingsMap` keys only | `packages/swimcloud/src/rosterPage.ts`, `teamSeasons.ts`: wrap, do not edit |
| `packages/swimcloud/src/browser/{enrich.ts, teamWindow.ts, rosterFetch.ts (new), rescore.ts, index.ts}` | `manifest.json` permissions (a same-origin content-script fetch needs none) |
| `packages/engine/src/{sourcing/flyover.ts (new), sourcing/convert.ts, sourcing/cutTag.ts, model/results.ts, autobuilder/squads.ts, index.ts}` | `data/**` |
| `tests/**` (new), `tests/engineScoreMeet.test.ts` (the pinned throws), `tests/fixtures/swimcloud/p4/**` (new), `tests/fixtures/swimcloud/simulator/README.md` (id map) | Any git operation |

## 2. Shared decisions

| Id | Decision | Why |
|---|---|---|
| Q | Every extra request runs in the isolated-world overlay with its own `fetch`, never in the bridge. | The MAIN-world hook (install.ts:143-198) would post the response as page data. D3:688-691 keeps the queue in the content script. |
| W | The overlay sends raw `200` bodies over the panel port. The docked panel (an extension page, an allowed writer, D3 5.3) parses everything again and writes. No service-worker broker in P4. The dashboard tab (`host=tab`) shows "Open the simulator page to fetch". | A content script cannot open IndexedDB (schema.ts:8-10). |
| C | The overlay classifies each response before delivery (section 3). The panel trusts nothing it did not parse. | Fail loudly; stop on a challenge. |
| H | Team-window data (LCM, split window, extended window) is a session cache in the docked panel, keyed by request path, lost on reload. Only rosters persist. | `swimmerHistory` (schema.ts:122-127) is keyed by swimmer with one `sourceUrl`, and `putCache` replaces the row. Persisting needs payload v2 (the frozen v2 fixture holds a v1 payload) and a one-transaction merge: open choice U4. |
| S | A season key is the label `YYYY-YYYY` the page prints. `RosterRecord.seasonId` and `ClassYearOverrideRecord.seasonId` both use it. The numeric `season_id` is only a request parameter, copied verbatim. | The override key has no team (schema.ts:161-166); teamSeasons.ts:9-15 says numeric ids are not proven site-wide. Departs from the D3:886 example `"26"`. Nothing writes rosters yet. Storage checks `seasonId` only as a string (validate.ts:540). |
| K | For a non-SCY swim, `MeetSwim.eventKey = scyEventKeyFor(recordedKey, course)`, the yards event it competes in. `scy` is computed from the recorded key first. The engine gains `recordedEventKeyFor(eventKey, course)` (500↔400, 1000↔800, 1650↔1500 for SCM and LCM; identity otherwise). cutTag.ts:214-229 uses it for the own-course lookup. | One key passes validation (validate.ts:419), seeds the 500 (results.ts:395) and converts through the 400 row (convert.ts:127). |
| P | Parity reads the raw snapshot only. `rescoreSimulator` and `parityReport` never see P4 data. `SIMULATOR_SOURCING` (rescore.ts:21) gains `flyover: {state:'unset'}` only. Never widen the window with a store dispatch. | A dispatch changes SwimCloud's own scores; Specific Dates mode makes every division unknown (adapt.ts:126-131, 159-176). |
| L | One builder, `dashboard/liveModel.ts`, serves all three sites (autoBuilderRequest.ts:150, scorerTagScoring.ts:40/81, suggestedRosters.ts:16). The literals at scorerTagScoring.ts:88 and suggestedRosters.ts:31 go. | Otherwise the panels disagree in silence. |
| I | Sanitized ids are numeric: `"9" + teamId + nn` (two digits), so `T58-S04` becomes `"95804"`. One map across every file of a capture set; the rule goes into `tests/fixtures/swimcloud/simulator/README.md`. | `toSwimCloudId` rejects `T58-S04` (schema.ts:26-35); a storage test fed those ids would quietly take the not-loaded path. |

## 3. P4.0 Fetch queue, protocol and season list (foundation)

Types (`apps/extension/src/shared/fetchProtocol.ts`, new, pure):

```ts
export type SimGender = 'M' | 'F';
export type TeamWindowTarget = { readonly kind: 'team-window'; readonly teamId: string; readonly gender: SimGender;
  readonly course: 'Y' | 'L'; readonly from: string; readonly to: string; readonly timeToUse: 'fastest' | 'average' };
export type RosterTarget = { readonly kind: 'team-roster'; readonly teamId: string; readonly gender: SimGender;
  readonly season: { readonly kind: 'server-current' } | { readonly kind: 'option'; readonly value: string; readonly label: string } };
export type FetchTarget = TeamWindowTarget | RosterTarget;
export type FetchFeature = 'roster' | 'lcm' | 'split-window' | 'extended-window';
export function fetchPathFor(t: FetchTarget): string;            // the only URL builder
export function targetForPath(path: string): FetchTarget | null;  // inverse; null for anything else
export const FETCH_MIN_DELAY_MS = 3000;     // legacy crawlPacing.ts:14
export const FETCH_MAX_RETRIES = 3;         // legacy rateLimitBackoff.ts:47
export const FETCH_BASE_BACKOFF_MS = 3000;  // rateLimitBackoff.ts:56
export const FETCH_MAX_BACKOFF_MS = 60000;  // rateLimitBackoff.ts:59
export const FETCH_LOCK_NAME = 'omniswim-swimcloud-fetch';
export function runEstimateMs(requests: number): number;          // (n - 1) * 3000
```

Paths:
- Team window: `/api/teams/{id}/simulator/?start_date=&end_date=&eventgender=&eventcourse=&divecourse=6&time_to_use=` (recon item 5).
- Roster, current season: `/team/{id}/roster/?gender={M|F}`.
- Roster, chosen season: `/team/{id}/roster/?page=1&gender=&season_id=&sort=name` (crawlPlan.ts:93-99).

Panel-port messages (in `panelProtocol.ts`):
- Panel to overlay: `fetch-run {runId, feature, targets}`, `fetch-cancel {runId}`.
- Overlay to panel: `fetch-progress {runId, index, waitMs, why}`; `fetch-item {runId, index, path, finalPath, contentType, body, fetchedAt}` (a `200` only); `fetch-end {runId, delivered, stopped: null | {reason, index, status, detail}}`.
- `FetchStopReason`: `'challenge'|'forbidden'|'rate-limited'|'server-error'|'unexpected-status'|'network'|'redirected'|'cancelled'|'lock-held'|'lock-unavailable'|'busy'`.

Queue (`overlay/fetchQueue.ts`): `runFetchQueue(run, deps:{fetch, sleep, now, locks, post}, signal)` and `classifyFetchResponse(target, r, nowMs, attempt)`. Use `fetch(path, {method:'GET', credentials:'same-origin', redirect:'follow', cache:'default'})` with no custom headers. Refuse any target whose `fetchPathFor` path does not round-trip through `targetForPath`.

Stop rules, in order:

| Response | Action |
|---|---|
| Network error or abort | Stop `network` (or `cancelled`) |
| `403` | Stop `forbidden` |
| `cf-mitigated: challenge` header, any status | Stop `challenge` |
| `429` | Retry after `Retry-After`, else `min(3000·2^attempt, 60000)`; after 3 retries stop `rate-limited` |
| `5xx` | Stop `server-error` |
| Any other non-200 | Stop `unexpected-status` |
| `200` whose final path and sorted query differ from the request | Stop `redirected` |
| `200` team window: content type not `application/json`, body does not parse, or not `{swimmers:[], relays:[]}` | Stop `challenge` |
| `200` roster: `<title>` starts "Just a moment", or `_cf_chl_opt` present, or no `<select name="season_id">`, or neither a `c-title` heading "Season …" nor "No rosters found" | Stop `challenge` (precedent multiTeamDriver.ts:370-382) |

- Pacing: each request, retries included, starts at least 3000 ms after the previous one started.
- One run at a time: a Web Lock with `ifAvailable`; held gives `lock-held`; no `navigator.locks` gives `lock-unavailable`; a second `fetch-run` during a run gives `busy`.
- Trigger: a run starts only from `fetch-run`, sent only from a click handler and only when `fetchPosture === 'on-click'` (schema.ts:177; default `'off'`, schema.ts:203). The button says "N requests, about S s". Never on page load, a snapshot or a bridge message (overlay.ts:8-9).
- Season list: the bridge also captures the page's own `GET /api/seasonchoices/` (no new request), caches it and posts `{kind:'seasons', url, body}` at capture and again on `ready` (install.ts:258-262). Rows: `seasonId` (number or string), `label` `/^\d{4}-\d{4}$/`, ISO `startDate`/`endDate`, `isCurrent`; exactly one current, else drop with a reason. The bridge stays under 10,000 B (extensionBundleBoundaries.test.ts:119; 5,643 B now).

Tests (T-Q), fake `fetch`/`sleep`/`now`: (1) starts at least 3000 ms apart; (2) a 403 stops and later targets are never fetched; (3) `Retry-After: 7` waits 7000 ms, the fourth 429 stops; (4) each challenge form stops; a real roster fixture and the UWF empty-state fixture are delivered; (5) a redirect stops; (6) a path the module did not build is refused; (7) no run without `fetch-run`; (8) the season list is re-posted after `ready`.

Mutations to kill: delete the 403 branch; deliver a non-JSON `200`; measure the delay from a request's end; match `challenge-platform` as a challenge (a normal page loads the invisible-check script, so the real-fixture test must fail).

Risk: core (classifier), executor. Button and dialog: worker.

## 4. F1.1a Roster season and class year

| Item | Rule |
|---|---|
| Requests | One roster page per team in the meet, for the meet's gender. A past season uses `season.kind:'option'`; its value comes from seasonchoices if live check 3 proves the ids equal, else from the team's own select (`parseTeamSeasonOptions`, one extra current-season request per team). The class-year season is the current season. |
| Record | `RosterRecord` (schema.ts:128-149): `teamId`, `seasonId` = label, `gender` `'Men'|'Women'`, `memberIds`, `verifiedEmpty?`, `classYears?` (FR, SO, JR, SR, GR only; key left out if none), `sourceUrl` = requested URL, `fetchedAt`, `parser {name:'readRosterFetch', confidence}`. Written with `putCache('rosters', …)`, which validates (validate.ts:537-565). A refused fetch writes nothing and keeps the earlier record. |
| Parse | `readRosterFetch(html, {target, requestedPath, finalPath}): RosterFetchOutcome` in `packages/swimcloud/src/browser/rosterFetch.ts`, wrapping `parseTeamRosterHtml` and `parseTeamSeasonOptions`. |

A `members` page: heading season = selected option label = target label (when given); heading gender = target gender.

Verified-empty needs all three: "No rosters found" (rosterPage.ts:217-233); selected option label = target label; final path = requested path. Gender comes from the request.

Refusals (no write): `missing-athlete-link` (rosterPage.ts:274-282), `unparsed-row` (265-271), `contradicted-page-declaration`, `unmapped-class-year` (577-583; the parser's `'unknown'` is never stored, validate.ts:559 would reject it), `zero-data-rows` with no empty-state text (295-300), a duplicate id, a season or gender mismatch, a `page=2` or pagination link (R86 approves one page). A class cell with "–" or nothing is absent for that swimmer (565-572).

Membership (`enrich.ts`):

| Roster season | Team roster | Simulator lists the swimmer | `MeetSwimmer.roster` |
|---|---|---|---|
| simulator-current (default) | any | yes | `member` (adapt.ts:193). A fetched roster is a cross-check only: list mismatches, never apply them. |
| season S | not loaded | yes | `unknown` |
| season S | members, id listed | yes | `member` |
| season S | members, id not listed | yes | `not_member` |
| season S | verified-empty | yes | `unknown` plus a contradiction note |
| season S | members, zero overlap with simulator ids | yes | `unknown` for the team plus note `id-join-suspect` |

- Remove a `not_member` swimmer's lineup entries and list them; a relay with such a leg is removed whole (else scoreMeet throws `roster_not_member`, results.ts:473).
- Members of S with no simulator data show as a count: "N on the 2025-2026 roster have no swims here".
- `MeetSwimmer.classYear` = `resolveClassYear` (classYear.ts:39-53) for the class-year season: `user` or `sourced` gives the code, `absent` gives `null`.

On screen: a roster-season select ("Simulator (current)", then seasonchoices labels); per-team status (Not loaded / No roster posted (time) / 42 swimmers (time) / refusal text); a "?" badge for unknown membership; a removed-entries list; a class-year column with source ("SwimCloud", "you", "?"); an override dropdown, disabled with a reason when no season label is known.

Fixtures (live, sanitized with map I, `tests/fixtures/swimcloud/p4/`): `roster-58-M-2026-27.html`, `roster-58-M-2025-26.html`, `sim-58-M-2026-27.json` (same id map).

Acceptance: T-R1 2026-27 gives 42 members, FR 8, SO 12, JR 12, SR 7, 3 absent; T-R2 UWF page plus matching request gives verified-empty, a season mismatch is refused; T-R3 each refusal writes nothing (repo spy: zero `putCache`); T-R4 the membership table row by row; T-R5 override > sourced > absent → `null`.

Mutations: absent record becomes `not_member`; `zero-data-rows` becomes verified-empty; drop the heading-season check; join by name; write class year `'unknown'`.

Risk: core, executor (parser, membership). UI: worker.

## 5. F1.3 Relay splits and flyover

F1.3a, engine only, no fetch. New `packages/engine/src/sourcing/flyover.ts`:

```ts
export type FlyoverSetting = { readonly state: 'unset' } | { readonly state: 'set'; readonly hundredths: number };
export interface SourcingSettings extends ConversionSettings { readonly flyover: FlyoverSetting }
export function flyoverFromSeconds(sec: number | undefined): FlyoverSetting; // undefined→unset; <0, NaN, >2 decimals throw
export function estimateFlyingLeg(flat: MeetSwim, legEventKey: EventKey, f: FlyoverSetting):
  { readonly hundredths: number; readonly usedConverted: boolean } | null;
export function splitScyValue(split: RelaySplit, division: DivisionRef, gender: Gender, s: ConversionSettings): Hundredths | null;
export function recordedEventKeyFor(eventKey: EventKey, course: Course): EventKey;   // decision K
```

- Departure from D2 3.10: `SourcingSettings` has no `splitWindow`; splits carry no date, so the window lives in the fetch target.
- Breaking change: `scoreMeet`'s parameter becomes `SourcingSettings` (results.ts:1047); the compiler finds every caller.
- results.ts:433: a `flyover-estimate` leg is worth `estimateFlyingLeg(...)`; `null` means no time.
- results.ts:449: a non-SCY split is worth `splitScyValue`; `null` means no time; never throws `split_not_scy`.
- squads.ts:84 and 165-180 use `splitScyValue`. Positions 2 to 4 get a flyover option only when the swimmer has no split option there. The option's flat swim is the fastest rankable swim of the leg event.

F1.3b, split-window fetch:

| Item | Rule |
|---|---|
| Request | One `team-window` per team: course `Y`, the page's gender and `timeToUse`, from the oldest `startDate` to the current `endDate` of the last N seasons (`splitWindowSeasonsByMeet ?? 2`, plan F1.3). Skipped when the dates equal the page's `recordRange`. Without a season list the control is disabled: "Season list not loaded; reload". |
| Store | Session cache H. |
| Parse | `parseTeamWindowResponse(body, ctx)` in `teamWindow.ts`, same row checks as the bridge (install.ts:41-50). The swimmer set must equal the snapshot's for that team, else refuse. Read `relaysplits` and `relayleadoffs` only. |
| Consume | For a fetched team, replace its flying splits and leadoff swims with the window's (ids `sw:{rowId}`). Rewrite the page lineup's relay legs onto the window data: a split for the same swimmer, leg event and start; else a `flyover-estimate` when the flyover is set and a flat swim exists; else `no-time`. List the changed legs. An unfetched team keeps the page's splits, noted "splits from record range". |
| Screen | A split-window select and fetch button. A flyover leg shows "est." with the flat time and the allowance; unset shows "no split"; both times when `usedConverted`. |

Acceptance: T-S1 `flyoverFromSeconds` cases; T-S2 `estimateFlyingLeg` (unset → `null`; 0 → flat; 0.30 on 21.50 → 21.20; mismatched leg event → `null`; extracted split → `null`; result ≤ 0 → `null`); T-S3 a `split` leg keeps its exact time with the flyover set; T-S4 squads offers no estimate where a split exists; T-S5 window splits replace page splits and no lineup reference dangles; T-S6 parity deep-equal with and without the window. Fixture: synthetic, derived from `team-58.json`, labeled synthetic.

Mutations: `flyover ?? 0`; subtract the flyover from a split; merge `indrecords` from the window; offer the estimate beside a real split.

Risk: core, executor. Update the pinned throws in `tests/engineScoreMeet.test.ts`.

## 6. F1.2 LCM swims

| Item | Rule |
|---|---|
| Request | One `team-window` per team: course `L`, the page's `recordRange`, gender and `timeToUse` (R84). |
| Store | Session cache H. |
| Parse | Every swim row has `eventcourse` `L`. Drop dive rows (they repeat SCY) and count them. Ignore relay rows (no relay conversion, R60) and count them. Swimmer set must equal the snapshot's, else refuse the team. |
| Absent / empty | Fetched with zero rows is "SwimCloud lists no LCM swims for this team in this window": a verified answer, never "not loaded". |
| Consume | Each row becomes a `MeetSwim`: `swimId 'lcm:{rowId}'`, `eventKey` per K, `recordedCourse 'LCM'`, `date: null`, `seasonId: null`, origin `history-fetch`, `scy` from `scyStatementFor` with the recorded key (convert.ts:140-159). A swim whose yards event is not in the meet is dropped and counted. A leadoff gets `extractedSplit`. LCM `relaysplits` become `RelaySplit` with course `LCM`, valued through `splitScyValue` (R62). Toggle off: every LCM swim carries `conversions_excluded`. |
| Screen | "Include converted swims" per meet (`includeConvertedSwimsByMeet`, absent = off). Each swim shows "LCM 4:00.00 → 3:30.71 · converted · est." with a basis tooltip (tool-derived, SwimSwam, R58). Not convertible shows "no conversion". |

Acceptance (rewrites the F1 line): T-L1 parse rules and refusals; T-L2 a 400 Free LCM swim gets `eventKey '500 Freestyle'`, `basis.lcmEventKey '400 Freestyle'`, passes `validateMeetModel`, seeds the 500; T-L3 toggle off equals the SCY-only lineup, on changes it only where a converted swim is faster; T-L4 an empty response shows the verified-none note; T-L5 a converted swim tags at best `estimated-achieved` (R61); T-L6 `recordedEventKeyFor` round-trips and cutTag.ts:214-229 gives the same tag for an NAIA SCM 400 under either key.

Mutations: compute `scy` from the mapped key (T-L2 then sees `event_not_swum_in_course`); keep dive rows; treat empty as not fetched.

Before relying on it: the state-file follow-up requires `checkProvenanceSources` before any stored lineup snapshot carries a tool-derived basis.

Risk: core, executor. UI: worker.

## 7. F1.1 Wider window

| Item | Rule |
|---|---|
| Request | One `team-window` per team: course `Y`, from today minus 7 years (or 5) to the page's `to`. Live check 7 decides the depth once, as a pinned constant with a recon citation. No runtime ladder: a clamped response cannot be told from an honored one. |
| Consume | Page response = W0 (the snapshot), wide = W1. Per swimmer and event, add the W1 row (`ext:{rowId}`) only when strictly better than the W0 best (or W0 has none); a dive is better with a higher score. W0 swims stay. `model.extendedWindow` is true when at least one row is added. `recordRange` becomes W1. W1 splits and leadoffs are ignored (the split window governs them). |
| Screen | Extended-window select (Off, 7 y, 5 y), fetch button, "extended window" badge on each added swim. |

Acceptance: T-W1 strictly faster gets the badge and is used, equal keeps W0 with no badge, missing from W0 gets the badge; T-W2 dives by higher score; T-W3 a swimmer-set mismatch is refused; T-W4 parity unchanged. Fixture: W0 and W1 from live check 8, else synthetic.

Mutations: `<=` for `<`; dives by lower score; replace all W0 rows with W1.

Risk: core, executor.

## 8. Build order

| Step | Work | Needs | Runs alongside |
|---|---|---|---|
| 1 | P4.0 | — | 2 (disjoint files) |
| 2 | F1.3a engine (includes K, `splitScyValue`) | — | 1 |
| 3 | Live visit (section 9) | user present for check 9 (extension loaded) | — |
| 4 | F1.1a | live checks 1-5, 10 | — |
| 4b | liveModel wiring (added 2026-11-06, F1.1a ruling 2): `dashboard/liveModel.ts` (decision L) applies roster membership after `adaptSimulatorSnapshot`, drops or reports scorer tags on `not_member` swimmers, stores the roster-season choice outside component state, passes class years for every team, never touches `rescoreSimulator` | 4 | — (touches Score, Build and Plan in `main.tsx`) |
| 5 | F1.3b | step 1 season list | serial with 4 (shares `enrich.ts`) |
| 6 | F1.2 | live check 6 | — |
| 7 | F1.1 | live checks 7-8 | — |

F1.3 goes before F1.2: its data is proven to be in the page and its engine half needs no fetch; F1.2's approved route probably yields nothing (finding 1). If live check 1 shows a challenge, F1.1a waits for U9 and steps 5 and 6 go first (the JSON API paths were not challenged).

## 9. Live checks for the one Chrome visit

Same-origin requests from the simulator tab, at least 3 s apart. Stop on a challenge or a 403. Save nothing raw.

| # | Check | Requests | Settles |
|---|---|---|---|
| 1 | `fetch('/team/58/roster/?gender=M')`: status, content type, `cf-mitigated`, `<title>`, heading, select | 1 | Background roster fetch; challenge detector |
| 2 | `/team/58/roster/?page=1&gender=F&season_id=30&sort=name`: heading "Season 2026-2027 Women", selected 30 | 1 | Gender and season parameters |
| 3 | The page's own seasonchoices body: is 2026-27 `seasonId` 30? Requested on every load? | 0 | Decision S request source |
| 4 | One roster `/swimmer/{id}` present in `origRosters[58].swimmers`? | 0 | Id join |
| 5 | Pagination markup on the team 58 page; optionally one large roster if the user allows | 0-1 | U8 |
| 6 | `eventcourse=L`, team 58, 2025-06-01 to 2025-08-31 | 1 | Finding 1 |
| 7 | Season 2019-2020 click (the page's own request), then one span request 2019-09-01 to today for team 58: is a span relay equal to a 2019-20 relay and faster than the 3-year best? | 1 + T | F1.1 depth |
| 8 | A current swimmer with a same-team swim older than 3 years (diff of item 7) | 0 | F1.1 fixture |
| 9 | After E4: repeat check 1 from the extension's isolated world | 1 | Content-script equivalence |
| 10 | Distinct Class values on rosters 58, 48 and 412 | 2 | Class vocabulary (GR? 5Y?) |
| 11 | 2026-27 relays for teams 48, 58, 412 (the page's own Season click) compared with the 2022-23 rows of the P4 recon | 0 | Rules out "too-old window returns current relays" (lead, advisor) |

**Results (2026-11-05):** checks 1-8, 10 and 11 ran; check 9 waits on E4. See `02-SIMULATOR-RECON.md` section "D7 live checks, 2026-11-05". Summary: no challenge on a background roster fetch; `gender` and `season_id` work; season 30 = 2026-27; the id join holds (42 of 42); no pagination; team-scope LCM in summer 2025 is empty for team 58; a 7-year window is honored but adds one individual best and no relay over 3 years; Class values FR, SO, JR, SR and "–" only. Captures were not taken (raw bodies not saved); fixtures stay synthetic until a capture is approved.

Captures, sanitized with map I: the three files of section 4, the item 6 response, W0 and W1 from items 7 and 8.

## 10. Open choices for the user (each with a default)

| Id | Choice | Default |
|---|---|---|
| U1 | Cross-team LCM swims through `/api/swimmers/{id}/profile_fastest_times/`: one request per swimmer, bests only, dated. About 120 requests (6 min) for 3 teams. | No. Build the team route; show "no LCM swims" honestly. |
| U2 | SCM swims with `eventcourse=S`: one more request per team (not in R84) | No |
| U3 | `times_by_event` for former members, transfers (R49) and robust mode (R85, D5:671) | No |
| U4 | Persist team-window data in `swimmerHistory` (payload v2, a merge method) | No; session only |
| U5 | `fetchPosture` default after R84-R88 | Keep `'off'`; the user turns it on once |
| U6 | "Include converted swims" default per meet | Off |
| U7 | An unmapped Class word | Refuse the whole roster, loudly |
| U8 | A paginated roster | Refuse; R86 approves one page |
| U9 | The background roster fetch is challenged | Stop; tell the user to open the roster page in a tab, then retry. Alternative: a content script on `/team/*/roster/` pages |
| U11 | Build F1.1 at all, given finding 4 | Build it last, depth from live check 7 |

## 11. Notes from the architect

- `packages/swimcloud/src/browser/history.ts:97-103` writes `recorded-scy` on every row whatever the course. An LCM `times_by_event` row would fail `validateMeetModel`. It is not wired today; fix it if U3 is approved.
- The season key departs from an earlier advisor default (the roster page's numeric option value): `classYearOverrides` has no team in its key, and the numeric ids are not proven site-wide.
- Inferred, not tested: that an isolated-world fetch behaves like a page fetch (live check 9).
