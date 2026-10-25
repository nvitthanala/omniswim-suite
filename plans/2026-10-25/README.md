# 2026-10-25: Chrome extension redesign

The project pivots from a standalone suite to a Chrome extension that upgrades
the SwimCloud meet simulator, plus a dashboard inside the extension.

| File | What it is |
| --- | --- |
| `00-USER-PLAN.md` | The user's handwritten plan, verbatim. The embedded Table B image is extracted to `assets/table-b-altitude.png`; nothing else changed. |
| `01-REDESIGN-PLAN.md` | The detailed design: surfaces, architecture, feature specs, phases, delegation, risks, open questions. |
| `02-SIMULATOR-RECON.md` | Phase P0 checklist for studying the live simulator, and its findings. |
| `03-REPO-REORG.md` | The active-versus-legacy move map. |
| `docs/reference/REDESIGN_2026-10-25_STATE.json` | Progress record. Read it before resuming. |

## Decisions (user, 2026-10-25)

| ID | Question | Answer |
| --- | --- | --- |
| R1 | How to study the simulator | Claude researches it live through Claude in Chrome: "run your own research, i trust it". Start URL `https://www.swimcloud.com/meetsimulator/?event=1\|50\|Y\|1&teams=`. |
| R2 | Where the dashboard lives | "either within the extension, or have the extension be able to construct the dashboard into the meet simulator page". Plan: one dashboard app, two hosts. |
| R3 | The unmerged improvement-plan branch | Merge it first, then reorganize. PR #7. |
| R4 | NSISC total entry cap | 8 ("its nsisc, maximum of 8 cap"). The earlier 7 was the user's own incorrect information. Do not hardcode; every limit is configurable for any conference. |
| R5 | AutoBuilder "cushion" | All four modes: max own total, margin over a rival, robust to slow swims, goal seek. |
| R6 | Default session load | 2 races per session, relays included. Editable per meet. |
| R7 | Wider date window | "try and see if you can modify the system that actually interacts and retrieves said data when setting the window". Widen the simulator's own data request. Low usefulness, but useful for a best-case view. Extra per-swimmer fetches were **not** approved; they need recon and an explicit yes first. |
| R8 | Audience | Personal unpacked install first. Share with other coaches later; plan for it now. |
| R9 | Diver weight | NSISC: each diver counts as 1/3 of a roster spot. |
| R10 | Table D and conversions | Use SwimCloud's own converted times first. Table D is the fallback only, for an LCM swim SwimCloud shows no conversion for. |
| R11 | "Close to a cut" | Within 1.0%, and always show the time gap. A swimmer with their division's B cut is tagged and shows the gap to the A cut. Thresholds are settings. |
| R12 | What carries over from the suite | Saved lineups and snapshots; reports and entry export. Everything else moves to `legacy/`. |
| R13 | Codex | Full fresh quota available (user, 2026-10-25). Update `PROVIDER_ROUTING.json`. |

NSISC is the New South Intercollegiate Swim Conference. The repo's meet data
labels its meet "New South Championships". It is not the Northern Sun
conference (NSIC). An early research pass on 2026-10-25 confused the two;
nothing from that Northern Sun material is used here.

## Verified sources for the user's tables

- **Table A** (SCM to SCY) matches the NCAA Division II 2026-27 qualifying
  standards PDF (`https://ncaaorg.s3.amazonaws.com/championships/sports/swimdive/d2/2026-27D2WSW_QualStandards.pdf`,
  which cites the 2026-27 Rules Book, Appendix A-2), and
  `NCAA_SCM_CONVERSION_TABLES` in `packages/core/src/constants.ts`.
- **Table B** (altitude) matches the same PDF and
  `NCAA_ALTITUDE_ADJUSTMENT_TABLE` in `constants.ts`. The image shows ".0"
  for 100 yards at 3,000 to 4,250 ft; the PDF and the code both read 0.
- **Table C** (NSISC event order): no published source archived yet. Ships as
  a `user-stated` session preset.
- **Table D** (LCM to SCY with turn adjustments): no source found. Used only
  as the fallback in R10, stored as `user-stated`, shown with an "est." badge,
  and never used for cut tagging.
