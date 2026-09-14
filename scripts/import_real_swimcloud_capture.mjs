/**
 * Runs the ACTUAL SwimCloud import pipeline — the same functions and the
 * same write logic OpsModule.tsx's handleSwimCloudImport uses — against a
 * real captured fixture, and writes the result into a real workspace via
 * the running app's own API.
 *
 * This exercises the real path end to end, not a synthetic scenario:
 *   READ   — validate + classify + parse the real captured HTML
 *            (readSwimCloudClipboardPayload, classifySwimCloudUrl,
 *            parseTeamMeetSwimsHtml)
 *   EXPORT — convert to SwimmerResult[], the same shape a PDF import produces
 *            (swimCloudTeamMeetSwimsToSwimmerResults)
 *   WRITE  — the real conference-aware scoring-settings patch
 *            (buildScoringPatchForParsedPdf, extracted 2026-09-08 from
 *            OpsModule.tsx into packages/core/src/lib/scoringDefaults.ts
 *            for exactly this reason: it has zero React/UI dependency and
 *            a script needs to call it identically to how the button does),
 *            the same workspace-patch shape handleSwimCloudImport builds
 *            (meetCopyFromParsed + loadedMeet + conference + scoringSettings),
 *            persisted through the real Express route and real repo layer.
 *
 * Deliberately creates a NEW, clearly-labeled workspace rather than writing
 * into an existing one — this meet (356467, NSISC 2025-26 season) predates
 * the user's "HSU 2026-27 Roster Plan" workspace and does not belong merged
 * into it.
 *
 * Requires the shell dev server running locally (npm run dev -w @omniswim/shell).
 *
 * Usage: npx tsx scripts/import_real_swimcloud_capture.mjs
 */
import { readFileSync } from 'node:fs';
import { readSwimCloudClipboardPayload } from '../packages/swimcloud/src/clipboardPayload.ts';
import { classifySwimCloudUrl } from '../packages/swimcloud/src/urlClassifier.ts';
import { parseTeamMeetSwimsHtml } from '../packages/swimcloud/src/parser.ts';
import { swimCloudTeamMeetSwimsToSwimmerResults } from '../packages/matrix/src/lib/swimCloudMeetImportBridge.ts';
import { buildScoringPatchForParsedPdf, presetIdForConference } from '../packages/core/src/lib/scoringDefaults.ts';
import { meetCopyFromParsed } from '../packages/core/src/lib/meetSource.ts';

const SERVER = process.env.OMNI_VERIFY_SERVER ?? 'http://127.0.0.1:3000';
const CONFERENCE = 'NSISC';

const FIXTURE = 'tests/fixtures/swimcloud-real-meet-team-swims-356467-team58-page1.html';
const SOURCE_URL = 'https://www.swimcloud.com/results/356467/team/58/swims/';

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const html = readFileSync(FIXTURE, 'utf8');

  // Exactly the payload shape extensions/swimcloud-companion/content.js builds.
  const clipboardText = JSON.stringify({
    omniswimSwimCloudCapture: 1,
    sourceUrl: SOURCE_URL,
    retrievedAt: new Date().toISOString(),
    track: 'browser-extension',
    html,
  });

  section('READ 1/3 — validate clipboard payload');
  const payloadResult = readSwimCloudClipboardPayload(clipboardText);
  if (!payloadResult.ok) {
    console.error('REJECTED:', payloadResult.reason, payloadResult.message);
    process.exitCode = 1;
    return;
  }
  console.log('accepted. sourceUrl:', payloadResult.payload.sourceUrl);

  section('READ 2/3 — classify URL (same check handleSwimCloudImport does)');
  const classification = classifySwimCloudUrl(payloadResult.payload.sourceUrl);
  console.log('outcome:', classification.outcome, '| kind:', classification.resource?.kind);
  if (classification.outcome !== 'fetchable' || classification.resource.kind !== 'meetTeamSwims') {
    console.error('Unexpected classification — refusing to proceed.', classification);
    process.exitCode = 1;
    return;
  }

  section('READ 3/3 — parse real HTML into structured swims');
  const parseResult = parseTeamMeetSwimsHtml(payloadResult.payload.html, payloadResult.context);
  if (!parseResult.ok) {
    console.error('Parse failed:', parseResult.failure);
    process.exitCode = 1;
    return;
  }
  const parsed = parseResult.data;
  console.log('confidence:', parseResult.confidence);
  console.log('meet:', parsed.meetName, '| team:', parsed.teamName, '| gender:', parsed.gender);
  console.log('swims parsed:', parsed.swims.length, '| warnings:', parseResult.warnings.length);

  section('EXPORT — convert to SwimmerResult[]');
  const converted = swimCloudTeamMeetSwimsToSwimmerResults(parsed);
  console.log('men:', converted.men.length, '| women:', converted.women.length, '| skipped:', converted.skipped.length);
  for (const s of converted.skipped) console.log('  skipped:', s.reason, '-', s.eventLabel, s.subject ?? '');

  // handleSwimCloudImport's own logic: isSameMeet is only ever true for a
  // *second* capture landing on a workspace that already has this meet's
  // rows. This script always creates a fresh workspace, so it is always
  // false — the "first import" branch.
  const allRows = [...converted.men, ...converted.women];
  const presetHint = presetIdForConference(CONFERENCE);
  console.log('presetHint for conference', CONFERENCE, '->', presetHint);

  section('WRITE 1/2 — create the workspace (bare, so we know its baseline scoringSettings)');
  const createRes = await fetch(`${SERVER}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `NSISC 2025-26 — New South Championships (archived, via SwimCloud, page 1/8)`,
      conference: CONFERENCE,
    }),
  });
  if (!createRes.ok) {
    console.error('Workspace creation failed:', createRes.status, await createRes.text());
    process.exitCode = 1;
    return;
  }
  const created = await createRes.json();
  console.log('created workspace id:', created.id);

  // The exact scoring patch decision handleSwimCloudImport makes.
  const scoringPatch = buildScoringPatchForParsedPdf(created.scoringSettings, CONFERENCE, presetHint, allRows);
  console.log('scoringPatch computed:', Boolean(scoringPatch));
  if (scoringPatch) {
    console.log('  scorerEligibilityMode:', scoringPatch.scorerEligibilityMode);
    console.log('  maxIndividualScorersPerTeam:', scoringPatch.maxIndividualScorersPerTeam);
    console.log('  scorerCapScope:', scoringPatch.scorerCapScope);
  }

  section('WRITE 2/2 — apply the real import patch (same shape as onUpdate(...) in OpsModule.tsx)');
  const updatePatch = {
    ...meetCopyFromParsed(converted.men, converted.women),
    deletedSwimmers: [],
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    recruits: [],
    loadedMeet: {
      pdfFilename: `${parsed.meetName ?? 'SwimCloud meet'} (via SwimCloud)`,
      uploadedAt: Date.now(),
      conference: CONFERENCE,
      meetLabel: parsed.meetName,
    },
    conference: CONFERENCE,
    ...(scoringPatch ? { scoringSettings: scoringPatch } : {}),
  };

  const putRes = await fetch(`${SERVER}/api/workspaces/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatePatch),
  });
  if (!putRes.ok) {
    console.error('Workspace update failed:', putRes.status, await putRes.text());
    process.exitCode = 1;
    return;
  }
  const updated = await putRes.json();
  console.log('persisted men rows:', updated.menResults?.length, '| women rows:', updated.womenResults?.length);
  console.log('loadedMeet.pdfFilename:', updated.loadedMeet?.pdfFilename);
  console.log('scoringSettings.scorerEligibilityMode:', updated.scoringSettings?.scorerEligibilityMode);
  console.log('scoringSettings.maxIndividualScorersPerTeam:', updated.scoringSettings?.maxIndividualScorersPerTeam);

  section('VERIFY — read back from the real store, independent of this process');
  const listRes = await fetch(`${SERVER}/api/workspaces`);
  const all = await listRes.json();
  const found = all.find((w) => w.id === created.id);
  console.log('found on GET /api/workspaces:', Boolean(found));
  if (found) {
    console.log('round-tripped men rows:', found.menResults.length);
    const sample = found.menResults.find((r) => r.name === 'Colin Candebat' && r.event === '200 Y IM');
    console.log('spot-check (Colin Candebat, 200 Y IM):', sample ? `${sample.time}, rank ${sample.rank}` : 'NOT FOUND');
  }

  console.log(`\nDone. Workspace id ${created.id}, "${updated.name}", is now real persisted app data.`);
  console.log('Open Matrix to see it, or delete it from the workspace list if you do not want to keep it.');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exitCode = 1;
});
