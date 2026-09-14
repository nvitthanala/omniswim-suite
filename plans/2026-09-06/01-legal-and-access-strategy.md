# Legal & access strategy

Findings below come from three checks run 2026-09-07: a direct fetch of
`robots.txt`, a Wayback Machine snapshot of the Terms of Use (live fetch of
the ToS page itself 403'd — see §3), and live `curl` probes against real
SwimCloud pages. Quoted verbatim where it matters; nothing here is
paraphrased from memory.

## 1. robots.txt — narrower obstacle than expected

`https://www.swimcloud.com/robots.txt`, HTTP 200, fetched directly. For a
generic client (`User-agent: *`, not a named crawler):

```
User-agent: *
Allow: /
Disallow: /api/
Disallow: /jsonapi/
Disallow: /team/*/facilities/
Disallow: /tz_detect/
```

No `Crawl-delay`. The named-crawler blocks (ClaudeBot, GPTBot, Amazonbot,
etc., all `Disallow: /`) don't apply to a generic or honestly-identified
client. **The four disallowed paths above are enforced in code as a hard
denylist**, regardless of which access track is used — see
[03](03-architecture.md).

## 2. Live Cloudflare behavior — JS challenge, not a hard block

`curl` (browser-like UA, no JS engine) against real pages, same session,
~90 seconds apart to rule out simple rate escalation:

| URL | Result |
| --- | ------ |
| `/` , `/about/` | 200 OK, real HTML, no challenge |
| `/terms/`, `/team/633/`, `/team/633/roster/`, `/results/`, `/swimmer/` | 403, Cloudflare Managed/JS Challenge ("Just a moment...", Turnstile-capable CSP) |

The split is **path-based** (marketing pages open, content pages gated), not
purely rate-based. A plain HTTP client cannot pass the challenge — there's no
JS engine to run it. A real browser engine (Playwright, or the user's actual
browser via the extension) can. This is the technical reason both access
tracks below exist: the extension runs inside the user's real, already-passed
session; the automated track needs Playwright specifically, not `fetch`/
`requests`.

## 3. Terms of Use — the load-bearing finding

Direct fetch of `/terms/` returned the same Cloudflare challenge (403).
Retrieved instead via Wayback Machine:
`https://web.archive.org/web/20260203140544/https://www.swimcloud.com/terms/`
(captured 2026-02-03; entity "CollegeSwimming.com, LLC", last modified
2024-08-30).

Permitted use is narrow and enumerated — personal, non-commercial viewing,
incidental caching, printing:

> "These Terms permit User to use the Website for User's personal,
> non-commercial use only. User must not reproduce, distribute, modify,
> create derivative works of, publicly display, publicly perform, republish,
> download, store, or transmit any of the material on the Website, except as
> follows: [temporary RAM caching incidental to viewing; browser
> display-cache files; printing one copy of a reasonable number of pages...]"

The operative clause for this project — unqualified, no personal-use
exception:

> "User shall not: ... Use any robot, spider, or other automatic device,
> process, or means to access the Website for any purpose, including, but
> not limited to, monitoring or copying any of the material on the Website."

Breach consequence stated in the same document: loss of the right to use the
site and a duty to destroy copies, at the company's option. The document also
names an explicit escape hatch:

> "If User wishes to make any use of material on the Website other than that
> set out in this section, please address User's request to:
> support@swimcloud.com."

**This is a civil/contract matter, not a criminal one.** hiQ Labs v.
LinkedIn (9th Cir.) and Van Buren v. United States (SCOTUS, 2021) both point
toward: accessing publicly-viewable pages without defeating a technical
access-control barrier (like a login) does not trigger CFAA
("unauthorized access") liability, even when it violates a site's stated
terms. hiQ still lost decisively on *state-law* contract/tort theories
($500k judgment, injunction) after the CFAA claim failed — so "not a CFAA
violation" is not the same as "no consequence." Meta v. Bright Data (N.D.
Cal., 2024) found in the scraper's favor, but turned on the scraper being
logged out with no account/agreement with Meta — a different posture than a
tool run by someone who may be a registered SwimCloud user. None of this is
legal advice; it's the shape of the risk the user is accepting for track B
below.

## 4. Two access tracks, both in scope (recorded decision)

### Track A — human-triggered browser extension (default, no ToS conflict argument needed)

A Manifest V3 extension adds an "Import to Omniswim" action on SwimCloud
pages the user is *already viewing* in their own logged-in browser. Nothing
fetches on its own; it acts only on an explicit click, on the page currently
loaded by the human. This sidesteps the Cloudflare challenge entirely (it's
the user's already-authenticated session) and sits in a materially different
place than track B — it is arguably not "a robot... access[ing] the Website,"
since no request the extension triggers happens outside the user's own
manual navigation. Still not risk-zero (the ToS's "automatic device" language
could be read broadly), but categorically different from an unattended
fetcher.

### Track B — automated fetch-on-paste (accepted risk, explicit and recorded)

Paste a link into the app; a local Playwright instance renders it and hands
the DOM to the same parser Track A uses. This is a direct breach of the ToS
clause quoted above — there is no reading of "any robot... for any purpose"
that excludes a polite, rate-limited, single-user Playwright job. The user
was shown this clause and chose to proceed anyway. Constraints that apply
regardless of that choice, not because they make it compliant (they don't),
but because they're the difference between "one coach's personal tool" and
"a bulk scraper," which is also the line the case law above tracks:

- **Single operator only.** Runs under the current user's own machine/
  session; no shared credentials, no other coach's traffic multiplexed
  through it.
- **On-demand only.** Fires on an explicit paste, never on a schedule.
- **Rate-limited and cached.** Seconds between requests, never concurrent;
  every fetched URL is cached and never re-requested once marked final (see
  [03](03-architecture.md) "status-keyed cache").
- **Never redistributed.** Output stays in the user's local workspace/DB —
  no export path, no sharing feature, no publishing.
- **Denylist enforced in code**, not just in this doc: `/api/`, `/jsonapi/`,
  `/team/*/facilities/`, `/tz_detect/` are hard-rejected before any request
  is issued, even though track B has already accepted the larger ToS risk —
  robots.txt is the one part of this that's unambiguous, and there's no
  reason to cross it too.
- **No identity spoofing.** Honest User-Agent string with real contact
  info, not a browser-impersonation string — masking identity is what turns
  "breach of contract" into something closer to deceptive access.
- **The escape hatch stays open.** `support@swimcloud.com` is the actual fix
  for this risk, per the ToS's own text. Worth sending regardless of
  building track B — it doesn't block track B from shipping, but a "yes" from
  SwimCloud removes the ongoing risk track B otherwise carries indefinitely.

### Amended 2026-09-08: Track A′

Track A above was "human-triggered browser extension... nothing fetches on
its own; it acts only on an explicit click, on the page currently loaded by
the human." On 2026-09-08 the user decided, directly and after being shown
this exact paragraph, that the extension should instead auto-fetch every
page a full meet/team capture needs after one click — still from the user's
own logged-in session, never a headless bot, but no longer "acts only on
the page currently loaded."

That is Track B by this section's own definition, not Track A. The
extension is now **Track A′**: a browser-session Track B. It carries Track
B's contract risk (the ToS clause above has no personal-use or
single-request carve-out), and it adopts Track B's politeness constraints
in full — `SwimCloudPoliteFetcher`, imported directly rather than
reimplemented — same rate limiting, same robots.txt denylist, same
cache-final immutability listed above.

This is a separate, fresh risk acceptance from the Track B one recorded
above, which covered a different mechanism (the Playwright fetcher, still
unused). See `plans/2026-09-08/01-decisions.md` D1 for the full record of
what was shown to the user before deciding, and
`extensions/swimcloud-companion/README.md`, which must be rewritten in the
same commit that ships this — its "never fetches anything on its own"
claim becomes false.

## 5. What this doc does not decide

Whether track B keeps running long-term, or gets retired if SwimCloud ever
responds to an access request, is a standing open question — not resolved
here, revisit if/when there's a response.
