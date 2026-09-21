/**
 * Parse ACC, Big 12, SEC (and NSISC) sample PDFs via Python parser + point calculator.
 * Usage: node scripts/test_conference_pdfs.mjs
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function resolvePython() {
  const win = process.platform === 'win32';
  const venv = win
    ? path.join(root, 'venv', 'Scripts', 'python.exe')
    : path.join(root, 'venv', 'bin', 'python3');
  return fs.existsSync(venv) ? venv : win ? 'python' : 'python3';
}

const py = resolvePython();
const parser = path.join(root, 'backend', 'pdf_parser.py');
const calc = path.join(root, 'backend', 'point_calculator.py');

const pdfs = [
  '2026_acc_championship_full_meet_results_1col.pdf',
  'Big_12_S_D_Champ_Results_pdf.pdf',
  '2026_sec_complete_results.pdf',
  '2026_NSISC_Championships_Final_Results.pdf',
];

const env = {
  ...process.env,
  OMNI_PROJECT_ROOT: root,
  OMNI_DATA_DIR: path.join(root, 'data'),
};

// Every PDF actually present must parse and score — a failure here is a
// real defect, not a missing-fixture skip. Was: the loop logged
// PARSE FAIL/SCORE FAIL and continued with no effect on the exit code, so a
// parser that failed on all four present PDFs still reported nothing wrong
// (docs/reference/TEST_COVERAGE_AUDIT.md, "Weak"). A PDF that is simply
// ABSENT from this checkout is a legitimate skip, not a failure — these are
// local-only fixtures, not committed (same reason the runner gates
// test_individual_scoring.mjs/test_relay_scoring.mjs on a fixture path).
let presentCount = 0;
const realFailures = [];

for (const pdf of pdfs) {
  const pdfPath = path.join(root, pdf);
  console.log(`\n=== ${pdf} ===`);
  if (!fs.existsSync(pdfPath)) {
    console.log('  SKIP — file not found');
    continue;
  }
  presentCount += 1;

  let parsed;
  try {
    const out = execFileSync(py, [parser, pdfPath], {
      encoding: 'utf8',
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    parsed = JSON.parse(out.trim());
  } catch (e) {
    console.log('  PARSE FAIL:', e.message?.slice(0, 200));
    realFailures.push(`${pdf}: parse failed`);
    continue;
  }

  let scored;
  try {
    const out = execFileSync(py, [calc], {
      input: JSON.stringify(parsed),
      encoding: 'utf8',
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    scored = JSON.parse(out.trim());
  } catch (e) {
    console.log('  SCORE FAIL:', e.message?.slice(0, 200));
    realFailures.push(`${pdf}: score failed`);
    continue;
  }

  if (parsed.length === 0) {
    console.log('  PARSE FAIL: 0 rows from a PDF that exists — a real defect, not a clean parse of an empty meet');
    realFailures.push(`${pdf}: parsed to 0 rows`);
    continue;
  }

  const teams = new Set(parsed.map(r => r.team));
  const conf = parsed[0]?.conference ?? '?';
  const withPdf = parsed.filter(r => r.pdf_points != null).length;
  const overrideOk = scored.filter(
    r =>
      r.pdf_points != null &&
      Math.abs(Number(r.calculated_points) - Number(r.pdf_points)) < 0.001
  ).length;

  console.log(`  conference: ${conf}`);
  console.log(`  rows: ${parsed.length} | teams: ${teams.size}`);
  console.log(`  PDF points column: ${withPdf} rows | override applied: ${overrideOk}/${withPdf}`);
}

// SEC with NSISC-shaped workspace settings must still match pdf_points when lock is on
const secPdf = path.join(root, '2026_sec_complete_results.pdf');
if (fs.existsSync(secPdf)) {
  console.log('\n=== SEC + NSISC-shaped settings (usePdfPlacePoints: true) ===');
  const _nsiscSettings = {
    scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 18,
    maxRelaysScoringPerTeam: 2,
    scorerCapScope: 'meet',
    diverScorerWeight: 1 / 3,
    scorerEligibilityMode: 'roster',
    usePdfPlacePoints: true,
  };
  const parsed = JSON.parse(
    execFileSync(py, [parser, secPdf], { encoding: 'utf8', cwd: root, env, maxBuffer: 64 * 1024 * 1024 }).trim()
  );
  const _scored = JSON.parse(
    execFileSync(py, [calc], {
      input: JSON.stringify(parsed),
      encoding: 'utf8',
      cwd: root,
      env,
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
  );
  const withPdf = parsed.filter(r => r.pdf_points != null);
  const mismatches = withPdf.filter(
    r => Math.abs(Number(r.calculated_points) - Number(r.pdf_points)) >= 0.001
  );
  console.log(`  rows with pdf_points: ${withPdf.length}`);
  console.log(`  mismatches: ${mismatches.length}`);
  if (mismatches.length > 0) {
    console.error('  FAIL — first mismatch:', mismatches[0].name, mismatches[0].event);
    realFailures.push('SEC + NSISC-shaped settings: pdf_points mismatch');
  } else {
    console.log('  OK — all pdf_points rows match calculated_points');
  }
}

console.log('');
if (presentCount === 0) {
  // These four conference PDFs are local-only fixtures, not committed (see
  // plans/STATE.md's long-standing "commit the meet results PDF" item) — an
  // empty checkout with none of them present has nothing to test, which is a
  // legitimate skip, not a failure.
  console.log('SKIP — no conference PDFs present in this checkout (local-only fixtures, not committed)');
  process.exit(0);
}
if (realFailures.length > 0) {
  console.error(`FAIL — ${realFailures.length} real failure(s) against ${presentCount} present PDF(s):`);
  for (const f of realFailures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`OK — ${presentCount} present PDF(s), 0 failures`);
}
