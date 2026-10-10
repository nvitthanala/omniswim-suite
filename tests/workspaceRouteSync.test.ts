import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import {
  planRouteSync,
  type RouteSyncPlan,
  type RouteSyncSnapshot,
} from '../apps/shell/src/lib/workspaceRouteSync';

/**
 * A1: the shell's workspace/URL sync.
 *
 * The planner is pure. A small commit-loop model below runs it the way React would
 * (effect on changed deps, StrictMode's double mount run, updates applied after the
 * commit) so a regression to a "compare state and URL" rule shows up as a swap loop.
 */
const IDS = ['ws-a', 'ws-b', 'ws-c'] as const;

function snap(over: Partial<RouteSyncSnapshot> = {}): RouteSyncSnapshot {
  return {
    urlWorkspace: 'ws-a',
    urlGender: Gender.MEN,
    activeWorkspaceId: 'ws-a',
    activeGender: Gender.MEN,
    ...over,
  };
}

describe('planRouteSync (pure)', () => {
  it('cold load: a valid URL workspace leads and the URL is never written', () => {
    const plan = planRouteSync(null, snap({ urlWorkspace: 'ws-b', activeWorkspaceId: 'ws-a' }), IDS);
    expect(plan).toEqual({ setActiveWorkspaceId: 'ws-b' });
  });

  it('cold load with no URL params writes the selection into the URL in one plan', () => {
    const plan = planRouteSync(
      null,
      snap({ urlWorkspace: null, urlGender: null, activeWorkspaceId: 'ws-c', activeGender: Gender.WOMEN }),
      IDS
    );
    expect(plan).toEqual({ writeUrl: { workspace: 'ws-c', gender: Gender.WOMEN } });
  });

  it('cold load with an unknown workspace in the URL rewrites the URL to the selection', () => {
    const plan = planRouteSync(null, snap({ urlWorkspace: 'ws-gone', activeWorkspaceId: 'ws-a' }), IDS);
    expect(plan).toEqual({ writeUrl: { workspace: 'ws-a' } });
  });

  it('a re-run with unchanged inputs does nothing, even if URL and state differ', () => {
    // StrictMode runs the mount effect twice, and the first run's set has not rendered yet.
    const cur = snap({ urlWorkspace: 'ws-b', activeWorkspaceId: 'ws-a' });
    expect(planRouteSync(cur, cur, IDS)).toEqual({});
  });

  it('a state change (sidebar click) writes the URL and does not set state', () => {
    const prev = snap();
    const cur = snap({ activeWorkspaceId: 'ws-c' });
    expect(planRouteSync(prev, cur, IDS)).toEqual({ writeUrl: { workspace: 'ws-c' } });
  });

  it('a URL change (back/forward, shared link) sets state and does not write the URL', () => {
    const prev = snap();
    const cur = snap({ urlWorkspace: 'ws-b' });
    expect(planRouteSync(prev, cur, IDS)).toEqual({ setActiveWorkspaceId: 'ws-b' });
  });

  it('when both moved in one run the URL wins', () => {
    const prev = snap();
    const cur = snap({ urlWorkspace: 'ws-b', activeWorkspaceId: 'ws-c' });
    expect(planRouteSync(prev, cur, IDS)).toEqual({ setActiveWorkspaceId: 'ws-b' });
  });

  it('a URL that loses its workspace param is repaired from the selection', () => {
    const prev = snap();
    const cur = snap({ urlWorkspace: null });
    expect(planRouteSync(prev, cur, IDS)).toEqual({ writeUrl: { workspace: 'ws-a' } });
  });

  it('does nothing when there is no selection and no valid URL workspace', () => {
    const plan = planRouteSync(null, snap({ urlWorkspace: null, activeWorkspaceId: null }), []);
    expect(plan.setActiveWorkspaceId).toBeUndefined();
    expect(plan.writeUrl?.workspace).toBeUndefined();
  });

  it('gender: the URL leads on a cold load, the state leads after a toggle', () => {
    expect(planRouteSync(null, snap({ urlGender: Gender.WOMEN, activeGender: Gender.MEN }), IDS)).toEqual({
      setActiveGender: Gender.WOMEN,
    });
    expect(
      planRouteSync(snap(), snap({ activeGender: Gender.WOMEN }), IDS)
    ).toEqual({ writeUrl: { gender: Gender.WOMEN } });
  });

  it('gender: an unrecognised URL value is repaired, never copied into state', () => {
    const plan = planRouteSync(null, snap({ urlGender: 'Coed', activeGender: Gender.MEN }), IDS);
    expect(plan).toEqual({ writeUrl: { gender: Gender.MEN } });
  });
});

/** Minimal model of one provider + router + effect, with StrictMode's double mount run. */
function run(
  init: { url: { workspace: string | null; gender: string | null }; active: string; gender: Gender },
  events: Array<(m: Model) => void> = []
) {
  const m: Model = {
    url: { ...init.url },
    active: init.active,
    gender: init.gender,
    prev: null,
    lastDeps: null,
    urlWrites: 0,
    stateWrites: 0,
    commits: 0,
  };
  const settle = () => {
    for (let guard = 0; guard < 60; guard += 1) {
      const changed = commit(m);
      if (!changed) return;
    }
    throw new Error(`did not settle in 60 commits (url writes ${m.urlWrites}, state writes ${m.stateWrites})`);
  };
  settle();
  for (const event of events) {
    event(m);
    settle();
  }
  return m;
}

interface Model {
  url: { workspace: string | null; gender: string | null };
  active: string;
  gender: Gender;
  prev: RouteSyncSnapshot | null;
  lastDeps: string | null;
  urlWrites: number;
  stateWrites: number;
  commits: number;
}

/** One render commit. Returns true if the effect applied any change (which forces another commit). */
function commit(m: Model): boolean {
  m.commits += 1;
  const deps = JSON.stringify([m.url.workspace, m.url.gender, m.active, m.gender]);
  const first = m.lastDeps == null;
  if (deps === m.lastDeps) return false;
  m.lastDeps = deps;
  const runs = first ? 2 : 1; // StrictMode re-runs mount effects once.
  const pending: RouteSyncPlan[] = [];
  for (let i = 0; i < runs; i += 1) {
    const cur: RouteSyncSnapshot = {
      urlWorkspace: m.url.workspace,
      urlGender: m.url.gender,
      activeWorkspaceId: m.active,
      activeGender: m.gender,
    };
    pending.push(planRouteSync(m.prev, cur, IDS));
    m.prev = cur;
  }
  // Updates land after the commit's effect flush (the shell defers the workspace set).
  for (const plan of pending) {
    if (plan.setActiveWorkspaceId) {
      m.active = plan.setActiveWorkspaceId;
      m.stateWrites += 1;
    }
    if (plan.setActiveGender) {
      m.gender = plan.setActiveGender;
      m.stateWrites += 1;
    }
    if (plan.writeUrl) {
      if (plan.writeUrl.workspace) m.url.workspace = plan.writeUrl.workspace;
      if (plan.writeUrl.gender) m.url.gender = plan.writeUrl.gender;
      m.urlWrites += 1;
    }
  }
  return true;
}

describe('route sync model (commit loop with StrictMode)', () => {
  it('cold load on ?workspace=<other> settles on the URL workspace with no URL writes', () => {
    const m = run({ url: { workspace: 'ws-b', gender: 'Men' }, active: 'ws-a', gender: Gender.MEN });
    expect(m.active).toBe('ws-b');
    expect(m.url.workspace).toBe('ws-b');
    expect(m.urlWrites).toBe(0);
    expect(m.stateWrites).toBe(1);
    expect(m.commits).toBeLessThanOrEqual(4);
  });

  it('cold load with no params fills the URL once', () => {
    const m = run({ url: { workspace: null, gender: null }, active: 'ws-c', gender: Gender.WOMEN });
    expect(m.url).toEqual({ workspace: 'ws-c', gender: 'Women' });
    expect(m.urlWrites).toBe(1);
    expect(m.stateWrites).toBe(0);
  });

  it('after settling, an in-app switch updates the URL once and stays', () => {
    const m = run({ url: { workspace: 'ws-b', gender: 'Men' }, active: 'ws-a', gender: Gender.MEN }, [
      mm => {
        mm.active = 'ws-c';
      },
    ]);
    expect(m.url.workspace).toBe('ws-c');
    expect(m.active).toBe('ws-c');
    expect(m.urlWrites).toBe(1);
  });

  it('after settling, back/forward (URL change) moves the selection and does not write the URL', () => {
    const m = run({ url: { workspace: 'ws-b', gender: 'Men' }, active: 'ws-a', gender: Gender.MEN }, [
      mm => {
        mm.url.workspace = 'ws-a';
      },
    ]);
    expect(m.active).toBe('ws-a');
    expect(m.urlWrites).toBe(0);
  });

  it('the old "compare and correct" rule swaps forever on the same input (the harness can see the bug)', () => {
    // Reference model of the removed code: two effects, each fixing whichever side differs.
    let url = 'ws-b';
    let active = 'ws-a';
    let swaps = 0;
    let lastParam: string | null = null;
    let lastActive: string | null = null;
    for (let commits = 0; commits < 40; commits += 1) {
      const paramChanged = url !== lastParam;
      const activeChanged = active !== lastActive;
      if (!paramChanged && !activeChanged && commits > 1) break;
      lastParam = url;
      lastActive = active;
      const nextActive = paramChanged && url !== active ? url : active; // URL->state effect
      const nextUrl = activeChanged && url !== active ? active : url; // state->URL effect
      if (nextActive !== active || nextUrl !== url) swaps += 1;
      active = nextActive;
      url = nextUrl;
    }
    expect(swaps).toBeGreaterThan(10);
  });
});
