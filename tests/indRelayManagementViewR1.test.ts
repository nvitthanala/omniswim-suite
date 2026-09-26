// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * IndRelayManagementView wiring for the R1 core relay fixes (commit
 * cc89035f, plans/2026-09-24 R1):
 *
 *  - A relay-leg candidate pool built from athlete history
 *    (`relayLegHistoryCandidates`) reaches the "eligible swimmers" drag list
 *    for a vacant leg, badged "From history", and only ever as a leg
 *    candidate, never as an individual entry.
 *  - `relayLegRequirements(...).legDistanceYards` can be `null` when a
 *    relay's label names no distance; the vacant-leg card renders a clear
 *    "distance unreadable" state instead of "nully" and offers no time
 *    input.
 *  - `listEligibleRelayLegCandidates` is called with the relay's gender, so
 *    a SwimCloud-style relay label with no gender word (no "Men"/"Women"
 *    token) still filters out a Mixed-event row that belongs to the other
 *    program.
 *
 * Real meet rows come from `tests/fixtures/nsisc-2026-relay-followups-r1.json`
 * (2026 NSISC Championships) and the committed HSU roster export
 * `hsuroster26-27.txt`, the same sources `tests/relayFollowUpsR1.test.ts`
 * uses for the core-level tests of the same fixes. Written without JSX,
 * matching `tests/teamRosterRowEventLabel.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type SwimmerResult, type TeamScore, type Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { canonicalSwimmerName, simulateRoster } from '@omniswim/core/lib/utils';
import { parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import IndRelayManagementView from '../packages/manager/src/components/IndRelayManagementView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const DSU = 'Delta State University';
const M_200FR = 'Event 31 Men 4x50 Yard Freestyle Relay';

const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };
const { menResults } = fixture;

/** `hsuroster26-27.txt` lines 77-113 — Colton Bennett's history block, same
 * slice `tests/relayFollowUpsR1.test.ts` verifies against both ends. He swam
 * no 50 Free at the meet (see that file's "holds the roster export rows"
 * test), so his only route onto a 50-free relay leg is history. */
function coltonBennettHistory() {
  const lines = readFileSync(join(repoRoot, 'hsuroster26-27.txt'), 'utf8').split(/\r?\n/);
  const block = lines.slice(76, 113);
  expect(block[0]).toBe('Colton Bennett');
  return parseSwimCloudPasteDetailed(block.join('\n'), { team: HSU, gender: Gender.MEN }).swims;
}

function team(name: string): TeamScore {
  return { teamName: name, totalPoints: 0, swimmers: [], color: '#38bdf8' };
}

function bundle(allScored: SwimmerResult[], teams: string[]): ScoringBundle {
  return {
    allResults: allScored,
    allScored,
    events: [],
    visibleEvents: [],
    sortedTeams: teams.map(team),
    timelineData: [],
    teamStyleSignature: '',
  };
}

function baseWorkspace(over: Partial<Workspace>): Workspace {
  return {
    id: 'ws-r1-ui',
    name: 'R1 UI test',
    createdAt: 0,
    menResults: [],
    womenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    scorerRosterOverrides: [],
    ...over,
  } as Workspace;
}

describe('IndRelayManagementView (R1 relay follow-ups)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(props: Partial<React.ComponentProps<typeof IndRelayManagementView>> & {
    workspace: Workspace;
    gender: Gender;
    scoringBundle: ScoringBundle;
    selectedTeam: string;
  }) {
    await act(async () => {
      root.render(
        createElement(IndRelayManagementView, {
          whatIfMode: true,
          removeSeniors: false,
          onUpdate: () => undefined,
          hideTeamPicker: true,
          onSelectTeam: () => undefined,
          ...props,
        })
      );
    });
  }

  it('offers Colton Bennett from history, badged, on a vacant 50-free relay leg', async () => {
    // HSU's B-final 200 Free Relay (rank 9): vacate Scott Doll's leg0 with no
    // override, the same shape `simulateRoster` produces for a departed
    // swimmer (tests/relayFollowUpsR1.test.ts "drop seniors vacates his
    // relay legs"). Colton Bennett swam no 50 Free at the meet, so only his
    // history swim (22.93 SCY, hsuroster26-27.txt) can fill it.
    const excluded = new Set([canonicalSwimmerName('Scott Doll')]);
    const scored = simulateRoster(menResults, [], false, excluded);
    const ws = baseWorkspace({
      menResults,
      athleteHistory: coltonBennettHistory(),
      deletedSwimmers: [{ name: 'Scott Doll', gender: Gender.MEN }],
    });

    await render({
      workspace: ws,
      gender: Gender.MEN,
      scoringBundle: bundle(scored, [HSU]),
      selectedTeam: HSU,
    });

    expect(container.textContent).toContain('Colton Bennett');
    expect(container.textContent).toContain('From history');

    // Never an individual entry: he must not appear as a plain roster swim
    // anywhere his history swim's raw event/time pairing would only make
    // sense as a leg candidate (no "50 Freestyle" individual row exists for
    // him in the fixture).
    const individualRow = scored.find(r => !r.isRelay && r.name === 'Colton Bennett' && r.event === '50 Freestyle');
    expect(individualRow).toBeUndefined();
  });

  it('renders a clear state, never "nully", for a relay whose label names no distance', async () => {
    // Variant of the real HSU B-final 200 Free Relay with its distance token
    // stripped from the label — same construction as
    // tests/relayFollowUpsR1.test.ts "(b) ... a relay with no readable
    // distance takes no swim". No swim matches an unreadable leg, so it
    // stays vacant with no fill offered.
    const UNREADABLE = 'Event 31 Men Yard Freestyle Relay';
    const relabelled = menResults.map(r =>
      r.isRelay && r.event === M_200FR ? { ...r, event: UNREADABLE } : r
    );
    const scored = simulateRoster(relabelled, [], true);
    const ws = baseWorkspace({ menResults: relabelled });

    await render({
      workspace: ws,
      gender: Gender.MEN,
      scoringBundle: bundle(scored, [HSU]),
      selectedTeam: HSU,
    });

    expect(container.textContent).not.toMatch(/nully/);

    // Find the unreadable relay's own vacant-leg card (other HSU relays that
    // removeSeniors also vacated keep a real distance and legitimately show
    // a "Leg time (Ny)" input — this checks only the unreadable one).
    const unreadableNote = Array.from(container.querySelectorAll('p')).find(p =>
      p.textContent?.includes('Distance unreadable')
    );
    expect(unreadableNote, 'no "distance unreadable" note rendered').toBeTruthy();
    const legCard = unreadableNote!.closest('div.border')!;
    expect(legCard.textContent).toContain('Missing — distance unreadable');
    expect(legCard.querySelector('input[type="text"]')).toBeNull();
  });

  it("passes the relay's gender through, so a Mixed-row woman is not offered for a men's leg with a genderless label", async () => {
    // A SwimCloud-style relay label carries no gender word. Delta State's
    // Ave Owens has only a Mixed time trial on record (Event 403, filed
    // under the men's results — a real HyTek quirk the fixture captures);
    // she swims the women's program. Without the relay's gender threaded
    // through, `listEligibleRelayLegCandidates` defaults to no gender at
    // all for a genderless label, which happens to also exclude her — the
    // regression this guards is a caller reintroducing a path that resolves
    // the label's own (absent) gender word instead of the workspace's
    // `gender` prop and admits her.
    const GENDERLESS = 'Event 900 4x50 Yard Freestyle Relay';
    const dsuRelay: SwimmerResult[] = [0, 1, 2, 3].map(legIndex => ({
      id: `dsu-relay-${legIndex}`,
      rank: 1,
      name: legIndex === 0 ? '—' : `DSU Filler ${legIndex}`,
      classYear: legIndex === 0 ? '' : 'JR',
      team: DSU,
      time: legIndex === 0 ? '30.00' : '22.00',
      points: 0,
      event: GENDERLESS,
      gender: Gender.MEN,
      isRelay: true,
      roundSwam: 'Prelims',
      relayLegIndex: legIndex,
      relayLegVacant: legIndex === 0 ? true : undefined,
      relayMissingLeg: legIndex === 0 ? { legIndex: 0, stroke: 'free', reason: 'vacant' } : undefined,
    }));
    const ws = baseWorkspace({ menResults: [...menResults, ...dsuRelay] });

    await render({
      workspace: ws,
      gender: Gender.MEN,
      scoringBundle: bundle(ws.menResults, [DSU]),
      selectedTeam: DSU,
    });

    expect(container.textContent).not.toContain('Ave Owens');
  });
});
