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

for (const pdf of pdfs) {
  const pdfPath = path.join(root, pdf);
  console.log(`\n=== ${pdf} ===`);
  if (!fs.existsSync(pdfPath)) {
    console.log('  SKIP — file not found');
    continue;
  }

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
  const nsiscSettings = {
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
  const scored = JSON.parse(
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
    process.exitCode = 1;
  } else {
    console.log('  OK — all pdf_points rows match calculated_points');
  }
}
