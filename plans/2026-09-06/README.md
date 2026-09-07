# SwimCloud ingestion — design round, 2026-09-06

Goal: paste (or click-import) a SwimCloud link for a meet, team, athlete, or
conference and have it land as structured data in the existing roster/scoring
pipeline — instead of retyping times by hand. This folder is the **design**:
what we found researching SwimCloud's actual structure and legal posture, the
decisions that came out of it, and the architecture to build against. No code
has been written yet.

| # | File | What's in it |
| - | ---- | ------------- |
| 00 | [Executive summary](00-executive-summary.md) | Scope, decisions on record, non-goals |
| 01 | [Legal & access strategy](01-legal-and-access-strategy.md) | robots.txt / ToS findings, the two access tracks, politeness rules |
| 02 | [Data model & scoring](02-data-model-and-scoring.md) | Entities, NCAA Rule 7 point tables, provenance rules |
| 03 | [Architecture](03-architecture.md) | Packages, extension, fetch service, wiring into existing import UX |
| 04 | [Phasing](04-phasing.md) | Delegation sequencing, acceptance criteria, open questions |

## How this research was done

Three parallel research subagents (general-purpose, web-only) covered: (a)
SwimCloud's URL/data structure and prior-art scrapers, (b) its robots.txt,
Terms of Use, and live Cloudflare behavior, (c) swim-scoring rules and
comparable data-model precedent. Findings are cited inline in 01/02 with
source URLs and fetch dates; nothing here is invented from memory. See the full
subagent reports in this session's transcript for anything not quoted here.

## Decisions on record (2026-09-06, from the user)

- New package, integrated into this monorepo — not a standalone tool.
- On-demand fetch only, no scheduler/background sync, for now.
- Data model designed for multi-team/multi-coach from day one; **SwimCloud
  access itself stays single-operator** (only the current user's own
  browser/fetches) until that's revisited.
- **Both** access tracks in scope: a human-triggered browser extension, *and*
  an automated fetch-on-paste path that the user has explicitly, knowingly
  accepted as a Terms-of-Use breach (contract risk, not the criminal/CFAA
  kind — see [01](01-legal-and-access-strategy.md)). This is not a default
  either of us reached for; it's a recorded choice made after seeing the ToS
  clause quoted in full.
- SwimCloud is often the *only* source for a meet's results (no PDF
  available), so meet-results ingestion is in scope for both tracks — this
  isn't limited to roster/athlete lookup.
