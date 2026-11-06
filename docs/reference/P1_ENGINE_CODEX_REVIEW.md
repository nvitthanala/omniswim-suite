# P1.engine Codex review

Reviewed 2026-10-26 against HEAD `1c6f79f3`. Scope: the P1.engine diff and the requested D2 sections 2, 3 P1 items, 4, and 8. The earlier Claude audit findings were treated as fixed; accepted deviations in section 8 were not re-raised.

## Blocked on me

None. No in-scope defect found.

## Changed

Only this review file. The review was read-only apart from creating this file. No tests were run because another worker owns the gates and this dispatch prohibits Vitest, Stryker, and npm test.

## Found

None.

### Verdict: accept

The bridge rejects zero per-event caps and any per-event cap combined with a numeric meet-wide scorer pool before returning settings. It also rejects conflicting swimming and diving over-cap behavior, missing relay-pool eligibility under `points_pool`, and incomplete automatic rules. For the remaining complete preset shapes, the bridge emits explicit scorer eligibility, suppresses PDF-point sniffing, leaves absent unlimited fields absent, and uses the `999` sentinel only for stated unlimited values or to exempt diving from a swimming cap. The legacy scorer's conference lock is not triggered because the bridge does not supply a conference.

`parseCap` rejects missing values and numeric values at or above the legacy `999` sentinel; zero remains a distinct parsed cap, with the bridge refusing it where the legacy scorer requires a positive per-event cap. `parseRulePreset` requires all top-level setting keys and validates their values. `requireComplete` checks every applicable pending setting, while skipping only the eligibility-mode-specific not-applicable field.

The built-ins' published NCAA values are tied to the scoring manifest and ruleset. NSISC and Table C values cite the user plan or README decision rows; the R29 distance conversion rows remain pending. Provenance tests check cited wording, source hashes, and built-in version hashes. Fingerprint cases disclose known empty/non-discriminating inputs, and the theoretical-meet fingerprint has explicit non-empty result assertions. The race-analysis purity scan verifies it reads the engine implementation and checks the prohibited import forms.
