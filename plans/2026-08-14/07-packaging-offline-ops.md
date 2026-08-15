# 07 — Packaging, offline behaviour and operations

The suite's stated premise is local-first: *"all analysis is performed entirely
locally on your device"*. Getting it onto a second machine is where that premise
is tested, and today's `7af56513` shows it had not been.

---

## 1. First run requires the internet, in three places

**Severity: P1.** Verified on a clean clone today.

| Dependency | When | Failure mode offline |
| ---------- | ---- | -------------------- |
| `npm install` | first run | expected and understood |
| **`pip install pdfplumber`** into a fresh venv | **first server start** | PDF parsing unavailable |
| **Google Fonts** (Space Grotesk, JetBrains Mono, Inter) | every page load | falls back to system fonts |

The pip step is the surprising one. `server.ts:176-208` creates a venv and runs
`pip install pdfplumber` **at server startup**, streaming pip output to the
console. On the clean clone this ran for ~30 seconds before the server was
usable. On a machine with no internet it will fail, and the failure surfaces as
PDF upload not working later — not at the moment it happened.

### Assessment

- **Fonts:** low risk. The fallback stacks are already sensible
  (`ui-sans-serif, system-ui, sans-serif`), so an offline machine renders with
  system fonts — different, not broken. Self-hosting them would fix it properly
  but means committing font binaries.
- **pip:** medium risk, and the one to fix. A coach at a meet venue on hotel
  wifi, loading a fresh results PDF, is a plausible scenario.

### Proposed

1. Make the sidecar bootstrap **explicit and reported**: check for `pdfplumber`
   at startup and, if absent, log a clear line and surface a banner —
   *"PDF parsing unavailable: run `npm run setup:python` while online."*
   Do not silently attempt a network install during boot.
2. Add `npm run setup:python` as the documented online step, alongside
   `npm install`.
3. Optionally vendor a wheel for offline install.

**Effort:** ~half a day. **Value:** converts a late, confusing failure into an
early, actionable one.

---

## 2. The two launchers behave very differently

**Severity: P1 (partly fixed).**

| | `Start-OmniSwim-Suite.bat` | `Start-OmniSwim-Suite-Prod.bat` |
| - | - | - |
| Entry | `tsx server.ts` | `node dist/server.js` after a build |
| `PROJECT_ROOT` | correct | **was wrong — fixed today (`7af56513`)** |
| Exercised by tests | yes (playwright `webServer`) | **no** |

The prod launcher was completely broken (404 on every page, empty database) and
nothing caught it because no test runs that path. See
[06#3](06-testing-verification.md#3-no-test-drives-the-production-server).

**Also worth noting:** the dev launcher's banner says *"Desktop launcher syncs
FROM this checkout, then starts its own copy: `%USERPROFILE%\Desktop\omniswim
suite\...`"*. That is a third deployment path, mentioned in a `.bat` echo and
nowhere else. **Open question:** is that desktop-copy flow still real? If yes it
needs the same `PROJECT_ROOT` verification; if not, the message should go.

---

## 3. Demo/seed data depends on a gitignored file — resolved, worth keeping resolved

**Severity: resolved today, fragile by design.**

`data/omniswim.db` is gitignored (`*.db`). All workspace state lives there. A
fresh clone therefore has **no data** unless `SqliteRepo.init()` seeds from
`data/meets.json` — which *is* tracked, despite also being listed in
`.gitignore` (it predates the rule, so it stays tracked).

That is a subtle arrangement: the seed file is simultaneously gitignored and
committed. It works, but the next person to "clean up the gitignore" could
silently delete the only copy of the demo data from version control.

Today I refreshed `data/meets.json` from a live export so a fresh clone
reproduces current state (verified: seeds both workspaces, HSU men scores
1277.0).

**Proposed:**
- Add a comment in `.gitignore` at the `data/meets.json` line explaining that the
  file is deliberately tracked despite the pattern.
- Add `npm run seed:export` wrapping the backup-and-copy so refreshing the seed
  is a documented one-liner rather than a manual sequence.
- **Open question:** should the seed be the *demo* dataset rather than a snapshot
  of live working state? Right now they are the same file, so any experiment in
  the app becomes the thing a new clone sees.

---

## 4. `venv/`, `uploads/` and temp PDFs land in the project root

**Severity: P2.** `server.ts` writes `temp_${Date.now()}.pdf` and
`temp_psych_${Date.now()}.pdf` into `PROJECT_ROOT` (lines ~764, ~792), plus
`uploads/` and `venv/`.

Two consequences:
- The `PROJECT_ROOT` bug created `apps/venv/` and `apps/data/` as stray
  directories, which I had to clean up manually.
- Temp PDFs in the repo root will be caught by a careless `git add -A` unless the
  ignore rules hold (they currently do).

**Proposed:** write scratch to `os.tmpdir()` and clean up on completion.
**Effort:** ~1 hour.

---

## 5. No version or build stamp in the UI

**Severity: P2.**

The server logs `Omni Swim Suite running at http://localhost:3000 (commit
d0262ebe)` — good. The UI shows nothing. When a coach on another machine reports
a wrong number, the first question is "which build?" and there is no way to ask.

**Proposed:** put the commit short-hash in the footer next to
`SQLite · local-first`. The value is already computed server-side; expose it on
an endpoint or inject at build. **Effort:** ~1 hour.

---

## 6. Backups exist and are unattended

`data/backups/` receives a JSON export on demand (`POST /api/workspaces/backup`)
and the directory is gitignored. There is no retention policy and no scheduled
backup.

For a local-first tool holding hand-built roster work (313 changes in the HSU
workspace, representing real hours), an unattended local backup is worth having.

**Proposed:** write a backup on server start and keep the last N. **Effort:**
~2 hours. **Open question:** is the SQLite file itself backed up by anything on
your machine today, or is `data/backups/` the only copy?
