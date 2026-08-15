# 10 — Security and network exposure

Assessed 2026-08-15. Nothing in this file was found by exploiting a running
server — the network findings are read from `apps/shell/server.ts`, and the path
arithmetic in §2 was computed with `path.join` on strings, not by uploading
anything.

**Context that decides severity:** the intended use is a coach running this on a
laptop at a swim meet, on venue or hotel wifi. That is a hostile network shared
with strangers. The findings below are minor on a home machine and serious in the
scenario the product is actually for.

---

## 1. The server listens on every network interface, with no authentication

**Severity: P0 in the meet scenario.**

```ts
// apps/shell/server.ts:953 and :975
httpServer.listen(PORT, '0.0.0.0', () => { logServerReady(); });
```

```ts
// apps/shell/server.ts:992
console.log(`Omni Swim Suite running at http://localhost:${PORT} …`);
```

`0.0.0.0` binds **all** interfaces — loopback *and* the wifi adapter. The console
says `localhost`, which is where the operator's mental model comes from, so the
exposure is invisible.

Authentication is off in the default configuration:

```ts
const STORAGE_BACKEND = (process.env.OMNI_DB ?? 'sqlite').toLowerCase();
const AUTH_REQUIRED = process.env.OMNI_AUTH_REQUIRED === 'true' || STORAGE_BACKEND === 'postgres';
```

Default backend is SQLite, so `AUTH_REQUIRED` is false, `auth` is null, and every
route uses `optionalAuth` — which, with a null service, calls `next()`
immediately. There is no gate.

So on a shared network, anyone who can reach port 3000 can:

- `GET /api/workspaces` — read the full roster, every athlete's times and history
- `PUT /api/workspaces/:id` — rewrite the lineup
- `DELETE /api/workspaces/:id` — delete the workspace
- `POST /api/workspaces/:id/snapshots/…/restore` — roll it back
- `POST /api/parse-pdf` — spawn the Python sidecar

The roster data is not merely private working notes: it is athlete names, class
years and performance history for identifiable minors and young adults.

### Proposed fix

1. **Bind `127.0.0.1` by default.** One line. Local-first software should be
   local by default; expose deliberately, not incidentally.
2. **Add `OMNI_HOST` to opt into `0.0.0.0`,** and when it is set, refuse to start
   unless auth is configured — or at minimum print a loud, unmissable warning.
3. **Make the startup banner tell the truth** — print the actual bind address and
   whether auth is on:
   `Listening on 0.0.0.0:3000 (reachable from your network) — AUTH DISABLED`.

**Effort:** ~1 hour. **Risk:** low, but check whether anyone relies on
cross-device access (phone on the pool deck reading the laptop's server is a
plausible workflow worth preserving deliberately via `OMNI_HOST`).

---

## 2. Unauthenticated file upload writes outside the project directory

**Severity: P0 in the meet scenario, P1 otherwise.**

```ts
// apps/shell/server.ts:918-923
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
});
app.post('/api/analyze-video', upload.single('video'), async (_req, res) => {
  res.status(501).json({ error: 'Gemini video analysis reserved for a future release. …' });
});
```

Three problems compound:

**a. `file.originalname` is attacker-controlled and lands in the path.**
`Date.now()-` prefixing neutralises a *leading* `../`, but not one that follows a
path segment. Computed with `path.join`, not by uploading:

| `originalname` | Resolves to | |
| -------------- | ----------- | - |
| `race.mp4` | `C:\proj\uploads\1786…-race.mp4` | contained |
| `../../evil.txt` | `C:\proj\uploads\evil.txt` | contained (prefix absorbs the first `..`) |
| `x/../../../evil.txt` | `C:\evil.txt` | **escapes** |
| `a/b/../../../../../evil.txt` | `C:\evil.txt` | **escapes** |

**b. No `limits`.** No size cap, so a single request can write until the disk is
full.

**c. No `fileFilter`.** Any content type is accepted.

**And the 501 does not protect it.** multer is middleware: it writes the file to
disk *before* the handler runs. The endpoint declining to do anything with the
file is irrelevant — the write already happened.

Combined with §1, that is an unauthenticated arbitrary-file-write reachable from
the local network.

### Proposed fix

1. **Never use the client's filename.** Generate the stored name —
   `${uuidv4()}${path.extname(file.originalname).slice(0, 10)}` — and keep the
   original only as metadata if it is needed for display.
2. **Add `limits: { fileSize: … , files: 1 }`.**
3. **Add a `fileFilter`** restricted to expected video types.
4. **Assert containment** after multer resolves the path:
   `path.resolve(dest).startsWith(path.resolve(uploadDir))`, reject otherwise.
   Belt and braces, and it is the check that survives future refactors.
5. **Do not mount the upload middleware at all while the endpoint returns 501.**
   The cheapest fix available today: an endpoint that does nothing should not
   accept and store files. One line, removes the whole issue until the feature
   actually lands.

**Effort:** ~1 hour for all five. **Recommendation:** do (5) immediately and the
rest when the endpoint becomes real.

---

## 3. The auth implementation itself is sound

Assessed `packages/db/src/AuthService.ts` and `apps/shell/lib/authMiddleware.ts`.
Recorded so this is not re-reviewed:

| Practice | State |
| -------- | ----- |
| Password hashing | bcrypt, cost 10 ✅ |
| Session tokens at rest | SHA-256 hashed before storage, so a DB read does not yield usable tokens ✅ |
| SQL | Parameterised throughout — no string interpolation into queries ✅ |
| Registration atomicity | `BEGIN`/`COMMIT` with `ROLLBACK` on error ✅ |
| Expired sessions | Deleted on validation ✅ |
| Cookie | `HttpOnly`, `SameSite=Lax` ✅ |
| Login error message | Generic `INVALID_CREDENTIALS` — no user enumeration ✅ |

Gaps, all **P2** because this path is only reachable in the Postgres deployment
that nobody is running yet:

- **No rate limiting on `login`.** bcrypt at cost 10 is ~100 ms, which slows but
  does not stop credential stuffing.
- **No password policy** — `register` accepts any string.
- **`register` throws `EMAIL_EXISTS`**, which does enumerate users. Contrast with
  `login`, which correctly does not.
- **30-day sessions with no rotation** (`SESSION_TTL_MS`), and no "log out
  everywhere".
- **No `Secure` flag** on the cookie. Correct for `http://localhost`; wrong the
  moment this is served over TLS. Should be conditional on the request protocol.

---

## 4. `authMiddleware.ts` is one 1,600-character line

**Severity: P2, but fix it while you are in there.**

The entire file — imports, four exported functions, the middleware factory — is
collapsed onto a single line with no newlines. It is valid TypeScript and it
compiles, but it is effectively unreviewable, and it is the file that decides
whether a request is authenticated.

Security-relevant code that cannot be read in a diff will not be reviewed
properly. `git blame` on it is useless; a one-character change to `requireAuth`
logic would appear as a whole-file rewrite.

**Fix:** run Prettier on it. **Effort:** 2 minutes.

---

## 5. Not assessed

Stated so the coverage of this document is not overestimated:

- **The Gemini / `OMNI_AI_ENABLED` path** (`server.ts` ~line 900). Sends pasted
  content or an image to an external API when enabled. Off by default and needs a
  key, but the data-egress question deserves its own look given the app's
  local-first claim.
- **Share links** (`AuthService.createLink` / `GET /api/share/:token`). Postgres
  only, so unreachable today. Worth reviewing before any deployment: token
  entropy, expiry, and whether a link grants read or write.
- **Dependency vulnerabilities.** No `npm audit` was run.
