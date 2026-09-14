/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A relay leg with no class year is a leg, not noise.
 *
 * `backend/pdf_parser.py` read the relay swimmer line with one regex that
 * required a trailing class year on every leg:
 *
 *   (\d+)\)\s*((?:r:[\+\-]?\d*\.\d+\s+)?)([A-Za-z\-',\.\s\*#xX%]+?)\s+(FR|SO|...)
 *
 * A swimmer with no class year on file was therefore not merely missing a year.
 * He was missing from the relay. This is the individual result row's defect
 * (`_split_yearless_individual_line`) in a second place.
 *
 * In `2026_NSISC_Championships_Final_Results.pdf` it dropped Alessandro
 * Giustolisi (Delta State) out of three relays. In the 2026 ACC results it
 * dropped Claire Curzan (Virginia) out of four.
 *
 * A dropped leg also shifts the legs after it. `_build_relay_split_payload`
 * pairs `relay_names[i]` with split i, so Virginia's 400 free relay credited
 * leg 2's split to leg 1's swimmer, and so on down the relay.
 *
 * The fix reads each leg from its marker to the next marker, or to the end of
 * the line, and treats the class year as optional. An absent year is UNKNOWN,
 * the same sentinel the individual row uses. It is never guessed.
 *
 * A leg whose name is unreadable is a separate case, and it raises. There is no
 * third answer: the name cannot be read, and inventing one from the wreckage
 * would fabricate competition data. Returning the other legs — which this
 * parser did, behind a stderr WARNING — hands back a relay short one swimmer
 * that looks complete everywhere a coach can see.
 *
 * Every fixture below is a verbatim line from one of four archived meet PDFs,
 * as pdfplumber extracts it — including the mangled ones, which is why they
 * look like that. Sources:
 *   NSISC  2026_NSISC_Championships_Final_Results.pdf
 *   ACC    2026_acc_championship_full_meet_results_1col.pdf
 *   Big 12 Big_12_S_D_Champ_Results_pdf.pdf
 *   GLVC   glvc_results26.pdf
 *
 * Skips when Python is unavailable — the parser is Python and the runner is
 * Node. Absent ≠ passing: the skip line says so.
 *
 * Test: npx tsx scripts/test_yearless_relay_row.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function python(code) {
  for (const exe of ['python', 'python3', 'py']) {
    const run = spawnSync(exe, ['-c', code], { cwd: repoRoot, encoding: 'utf8' });
    if (run.error) continue;
    return run;
  }
  return null;
}

const probe = python('import sys; print(sys.version_info[0])');
if (!probe || probe.status !== 0) {
  console.log('SKIP  test_yearless_relay_row (python not available)');
  process.exit(0);
}

/** Verbatim relay swimmer lines, one per case the parser must get right. */
const LINES = {
  // NSISC, men's 4x50 medley B final. Every other leg carries a year.
  nsisc_mid_line: '1) Mateus Franco SR 2) Neill Mauss SR 3) Alessandro Giustolisi 4) Lars Hetzel JR',
  // NSISC, men's 4x100 free relay B final. Yearless leg last, and pdfplumber
  // runs the fourth marker onto the third leg's year ("Rodriguez JR4)").
  nsisc_line_end: '1) Ashtin Wallace FR 2) Kostantin Ilijic JR 3) Sergio Rodriguez Rodriguez JR4) Alessandro Giustolisi',
  // NSISC, men's 4x50 medley A final. The ordinary case, and the bulk of the data.
  nsisc_all_years: '1) Avery Henke JR 2) Oskar Cebula SR 3) Colin Candebat SO 4) Oliver Pozvai SO',
  // ACC, Virginia. Yearless leg first, "Last, First" names, reaction times.
  acc_lead_off: '1) Curzan, Claire 2) r:0.97 Moesch, Anna SO 3) r:0.35 Canny, Aimee SR 4) r:0.30 Curtis, Sara FR',
  // ACC. A surname with a space in it, every year printed.
  acc_all_years:
    '1) Johnson, Connor FR 2) r:0.25 Martin, Eli SO 3) r:0.29 Hayon, Will SR 4) r:0.08 George Mathew, Tanish SR',
  // Big 12, Houston women's 400 free relay. Two columns collided in extraction:
  // "Fresh SR" came out as "Fresh S4R)". The name is unreadable, not shorter.
  big12_column_bleed:
    '1) Goupil, Liya SR 2) r:0.33 Bruner, Sienna SO 3) r:0.21 Sathianchokwisan, Fresh S4R) r:0.14 Kerkman, Jenna SR',
  // GLVC. No years at all, and the leg's own splits share the segment.
  glvc_splits_inline: '1) Briley Larcom 2) r:0.35 Kayden Cooper r:+0.77 27.57 58.53 28.47 59.03',
  // GLVC. An "fi" ligature the font did not map: "Griffin" reads "Grif(cid:976)in".
  glvc_ligature: '3) r:0.22 Carson Olson FR 4) r:-0.01 Kadence Grif(cid:976)in SR',
  // Not swimmer lines. The split line that follows every relay, and page furniture.
  split_line: '1:28.08 (19.77) 1:08.31 (21.49) 46.82 (24.29) 22.53',
  page_header: '2026 New South Intercollegiate Swimming Conference',
};

// Each line is parsed on its own so one raising line cannot mask the rest.
// An unreadable leg raises, so the harness must report the raise as data.
const HARNESS = `
import json, sys
sys.path.insert(0, 'backend')
import pdf_parser

lines = json.loads(sys.stdin.read())
ok, errors = {}, {}
for k, v in lines.items():
    try:
        ok[k] = pdf_parser._parse_relay_leg_line(v)
    except ValueError as exc:
        errors[k] = f"{type(exc).__name__}: {exc}"
print(json.dumps({"ok": ok, "errors": errors}))
`;

function runHarness(payload) {
  for (const exe of ['python', 'python3', 'py']) {
    const run = spawnSync(exe, ['-c', HARNESS], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: JSON.stringify(payload),
    });
    if (run.error) continue;
    return run;
  }
  return null;
}

const run = runHarness(LINES);
if (!run || run.status !== 0) {
  console.error('python harness failed');
  console.error(run?.stdout ?? '');
  console.error(run?.stderr ?? '');
  process.exit(1);
}
const parsed = JSON.parse(run.stdout.trim().split('\n').pop());
const out = parsed.ok;
const errors = parsed.errors;

// --- The bug: a yearless leg is read, not skipped ------------------------------
assert.deepEqual(
  out.nsisc_mid_line,
  [
    { name: 'Mateus Franco', year: 'SR' },
    { name: 'Neill Mauss', year: 'SR' },
    { name: 'Alessandro Giustolisi', year: 'UNKNOWN' },
    { name: 'Lars Hetzel', year: 'JR' },
  ],
  'a leg with no class year is still a leg, and it holds its place in the order'
);
assert.equal(
  out.nsisc_mid_line[2].year,
  'UNKNOWN',
  'the class year is never guessed — the PDF does not carry one'
);

assert.deepEqual(
  out.nsisc_line_end,
  [
    { name: 'Ashtin Wallace', year: 'FR' },
    { name: 'Kostantin Ilijic', year: 'JR' },
    { name: 'Sergio Rodriguez Rodriguez', year: 'JR' },
    { name: 'Alessandro Giustolisi', year: 'UNKNOWN' },
  ],
  'the last leg ends at the end of the line, and "JR4)" is still a leg marker'
);

assert.deepEqual(
  out.acc_lead_off,
  [
    { name: 'Claire Curzan', year: 'UNKNOWN' },
    { name: 'Anna Moesch', year: 'SO' },
    { name: 'Aimee Canny', year: 'SR' },
    { name: 'Sara Curtis', year: 'FR' },
  ],
  'a yearless lead-off leg parses, and "Last, First" still normalizes'
);

// --- The common case must not move --------------------------------------------
assert.deepEqual(
  out.nsisc_all_years,
  [
    { name: 'Avery Henke', year: 'JR' },
    { name: 'Oskar Cebula', year: 'SR' },
    { name: 'Colin Candebat', year: 'SO' },
    { name: 'Oliver Pozvai', year: 'SO' },
  ],
  'every leg carries a year: unchanged'
);
assert.deepEqual(
  out.acc_all_years,
  [
    { name: 'Connor Johnson', year: 'FR' },
    { name: 'Eli Martin', year: 'SO' },
    { name: 'Will Hayon', year: 'SR' },
    { name: 'Tanish George Mathew', year: 'SR' },
  ],
  'reaction times and multi-word surnames: unchanged'
);

// --- A mangled name raises; it is never repaired into a plausible one ----------
//
// These two cases used to return the readable legs and print a WARNING to
// stderr. A short relay is competition data with a hole in it, and stderr is
// invisible to a coach reading the app, so the relay looked complete. The
// parser now refuses the line instead — the same policy as the yearless
// individual row, which raises rather than lose a result silently.
assert.equal(
  out.big12_column_bleed,
  undefined,
  'column bleed must not yield a short relay: a leg is missing and nothing says so'
);
assert.match(
  errors.big12_column_bleed ?? '',
  /^ValueError: unreadable relay leg on swimmer line /,
  'column bleed raises, and the message names the line it came from'
);
assert.match(
  errors.big12_column_bleed ?? '',
  /Sathianchokwisan, Fresh S/,
  'the raw unreadable segment is quoted, so the defect can be found in the PDF'
);
assert.ok(
  !/Fresh S Sathianchokwisan/.test(JSON.stringify(out)),
  'a name cut mid-word reads as a real swimmer with a middle initial; it is not one'
);

assert.equal(
  out.glvc_ligature,
  undefined,
  'an unmapped ligature truncates the name, so the line is refused rather than shortened'
);
assert.match(
  errors.glvc_ligature ?? '',
  /^ValueError: unreadable relay leg on swimmer line /,
  'the ligature line raises'
);
assert.match(
  errors.glvc_ligature ?? '',
  /Kadence Grif/,
  'the mangled segment is quoted verbatim in the error'
);
assert.ok(
  !/\{"name":"Kadence Grif"/.test(JSON.stringify(out)),
  '"Kadence Grif" would enter the roster as a swimmer who does not exist'
);

// --- Yearless legs whose splits share the segment ------------------------------
assert.deepEqual(
  out.glvc_splits_inline,
  [
    { name: 'Briley Larcom', year: 'UNKNOWN' },
    { name: 'Kayden Cooper', year: 'UNKNOWN' },
  ],
  'a leg name ends where the clock starts'
);

// --- Lines that are not swimmer lines ------------------------------------------
assert.deepEqual(out.split_line, [], 'the split line under every relay carries no legs');
assert.deepEqual(out.page_header, [], 'page furniture carries no legs');

// --- Only the unreadable lines raise ------------------------------------------
// The raise aborts a whole meet parse, so it must fire on exactly the lines that
// have no readable answer and on nothing else.
assert.deepEqual(
  Object.keys(errors).sort(),
  ['big12_column_bleed', 'glvc_ligature'],
  'no readable line may raise — every other fixture here parses clean'
);

console.log('PASS  yearless relay legs are recovered; an unreadable leg raises');
