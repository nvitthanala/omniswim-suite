# Onboarding: first-day setup

This page gets a new developer from a fresh clone to green gates. It lists the tools, the environment, the test gates and the baseline numbers to expect.

For what the app does, read [USER_GUIDE.md](USER_GUIDE.md). For the facts that cost debugging time, read [INVARIANTS.md](INVARIANTS.md). For environment variables, read the "Runtime configuration" section of the [README](../README.md).

## 1. Install the tools

| Tool | Version | Why |
|---|---|---|
| Node.js | 20 or newer (`engines.node` in [package.json](../package.json) is `>=20`; CI runs 22) | App, build, scripts and vitest |
| npm | Ships with Node | npm workspaces: `apps/*` and `packages/*` |
| Python | 3.12 in CI; any recent 3 works | PDF parsers in [backend](../backend) |
| Chromium via Playwright | Matches `@playwright/test` | The e2e specs and the extension harness |
| `pdftotext` | Optional | A few tests re-read archived cut-line PDFs |

Install the Node dependencies from the repository root:

```bash
npm install
```

## 2. Set up the Python environment

The server creates `venv/` and installs the pinned `pdfplumber` on first start. To do it by hand, run these commands from the repository root:

```bash
python -m venv venv
# Windows: venv\Scripts\activate    macOS or Linux: source venv/bin/activate
pip install -r backend/requirements.txt
```

`backend/requirements.txt` pins `pdfplumber` to an exact version, so parser output does not drift between runs. Set `OMNI_NO_AUTO_INSTALL=1` to make the server refuse runtime installs and exit with a message instead.

To lint and test the Python backend, install the dev tools and run them from `backend/`:

```bash
pip install -r backend/requirements-dev.txt
cd backend
python -m ruff check .
python -m pytest
```

## 3. Install the Playwright browsers

```bash
npx playwright install chromium
```

On Linux, add `--with-deps`. `npm test` and `npm run test:harness` fail in CI when Chromium is missing. On a developer machine they skip with a message.

## 4. `pdftotext` is optional

Some tests check the cut-line standards against the archived NCAA and NAIA PDFs. They need xpdf's `pdftotext`, because only xpdf has the `-table` flag. Poppler's `pdftotext` (what Ubuntu ships) lacks it.

You do not need it for a green run. The extracted text is committed next to each PDF under [data/cutlines/sources](../data/cutlines/sources/manifest.json), with its hash in `manifest.json`. Tests read that text when xpdf is absent. `node scripts/extract-cutline-text.mjs` rewrites it, and it refuses to run without xpdf.

## 5. Data files and which tests need them

- [data/demo-seed.json](../data/demo-seed.json) is committed. It holds invented sample data. A fresh install starts from it, and tests that need workspace data use it.
- `data/meets.json` is local, untracked and gitignored. It is this machine's live working store and holds real roster data. Never commit it.
- Tests that read the real `data/meets.json` skip when it is absent: `scripts/test_relay_overrides.mjs` (whole script), a few parts of other scripts (the runner prints `LOCAL-ONLY SKIPPED` lines), and a few vitest files such as `tests/divingEventImport.test.ts`.
- `data/swimcloud-captures/` is local and gitignored. Tests that need it skip.
- `data/local-rosters/` is local and gitignored. The roster text exports name real swimmers, so they are not committed. Put these files there: `hsuroster26-27.txt`, `oburoster202627.txt`, `possible_hsu_scoringteam2627.txt` and `NSISC_2026-27_ROSTER_FRAMEWORK.txt`. The path is set once in [scripts/lib/localRosters.mjs](../scripts/lib/localRosters.mjs).
- Seven vitest files read the two exports through [tests/helpers/localRosterPath.ts](../tests/helpers/localRosterPath.ts). Without the real files they read the committed stand-ins in [tests/fixtures/synthetic-rosters](../tests/fixtures/synthetic-rosters), which use the same line format with invented names. They do not skip. A green run on a clean checkout proves the logic on the stand-ins. Run the suite on a machine that holds the real files to check the real rows.
- `scripts/seed_hsu_roster.mjs` and `scripts/seed_obu_roster.mjs` need the real files. They stop with an error that names this page when a file is missing. They never fall back to invented text.

Every skip is counted. See the skip budget below.

## 6. Run the gates

Run these from the repository root. All four must pass before you hand work over.

| Gate | Command | What it covers |
|---|---|---|
| Lint | `npm run lint` | TypeScript for every workspace, the extension, then ESLint |
| Unit suite and skip budget | `node scripts/check_skip_budget.mjs` | Runs `vitest run`, then fails if a file skips more tests than [tests/skip-budget.json](../tests/skip-budget.json) allows |
| Script suite and e2e | `npm test` | The scripts in [scripts](../scripts) through [scripts/run-tests.mjs](../scripts/run-tests.mjs), then the Playwright specs |
| Extension harness | `npm run test:harness` | The built SwimCloud extension in real Chromium against fixture pages. Takes a few minutes |

While you iterate, run one file: `npx vitest run tests/<name>.test.ts`. Use `npm run test:unit` for the whole vitest suite.

To check that the scoring tests catch a changed number, run `npm run test:mutation -- --mutate packages/core/src/lib/relayScoring.ts` (Stryker, run by hand, one file at a time; see [reference/MUTATION_RESULTS_2026-10-14.md](reference/MUTATION_RESULTS_2026-10-14.md)).

`npm run test:harness` needs the built extension. Run `npm run build:extension` first if `extensions/swimcloud-companion/background.js` is stale. The harness skips with a message when the build is missing.

### Baseline numbers

These counts are approximate. They come from a quiet tree on 2026-10-14. Test counts grow with every change, so treat a nearby number as normal and a large drop as a signal to look. The skip count is exact, because the skip budget enforces it.

| Gate | Expected |
|---|---|
| `npm run lint` | 0 errors, 2 baseline complexity warnings |
| `npx vitest run` | About 265 files and 3,950 tests passed, 23 skipped, exit 0 |
| `node scripts/check_skip_budget.mjs` | 23 skipped, equal to the budget of 23, exit 0 |
| `npm test` | About 86 scripts passed, 0 failed, 1 skipped (including the e2e spec `ui-ia.spec.ts`) |
| `npm run test:harness` | 7 passed, 1 skipped (a known `fixme`) |

The budget has two columns. `local` is for a machine that holds the gitignored capture data. `ci` is for a clean checkout. On a clean clone, run `SKIP_BUDGET_ENV=ci node scripts/check_skip_budget.mjs` (in PowerShell, set `$env:SKIP_BUDGET_ENV='ci'` first).

## 7. Port 3000

- `npm run dev` runs `predev`, which calls [scripts/free-port.mjs](../scripts/free-port.mjs). That script stops whatever process listens on the port, so a fresh server always starts.
- **Do not kill a server you did not start.** Another session or another worktree may own port 3000. Check with `netstat -ano | findstr :3000` before you run `npm run dev`.
- `npm test` does not use port 3000. [scripts/run-tests.mjs](../scripts/run-tests.mjs) picks a free port for the e2e dev server, and scripts that start a server pick their own. Do not set `PORT` when you run it, because the server prefers `PORT` over `OMNI_PORT`.
- To run a second dev server by hand, set `OMNI_PORT` to another value.

## 8. Where to look next

- [../plans/STATE.md](../plans/STATE.md): current branch, base, and where the plan and state file live.
- [reference/IMPROVEMENT_PLAN_2026-10-10.md](reference/IMPROVEMENT_PLAN_2026-10-10.md): the open work, in priority order, with user decisions.
- [../CLAUDE.md](../CLAUDE.md): project rules, including data provenance. Never hand-type a competition time.
- [README.md](README.md): the full documentation index.
