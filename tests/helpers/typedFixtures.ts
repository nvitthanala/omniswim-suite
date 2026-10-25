/**
 * Typed fixture builders for tests that need a complete value of a core type.
 *
 * A test that only needs a few fields of `SwimmerResult` or `CutlineTagResult`
 * used to write a partial object literal and cast it. A cast hides a field the
 * type later gains or renames. These builders fill every required field with a
 * neutral value, so the test names only the fields it cares about and the
 * compiler checks the rest.
 *
 * The defaults are placeholders for a test input. None of them is a competition
 * time, a cut standard or a roster value.
 */
import { ClassYear, Gender, type SwimmerResult, type Workspace } from '../../packages/core/src/types';
import type { CutlineTagResult } from '../../packages/core/src/lib/cutlineTags';

type SwimmerResultRequired = Pick<SwimmerResult, 'id' | 'name' | 'time' | 'event'>;

/** A complete men's `SwimmerResult`. The caller names the identity fields and any override. */
export function swimmerResult(fields: SwimmerResultRequired & Partial<SwimmerResult>): SwimmerResult {
  return {
    rank: 0,
    classYear: ClassYear.JR,
    team: 'Test University',
    points: 0,
    gender: Gender.MEN,
    ...fields,
  };
}

/** A complete judged-miss `CutlineTagResult` (`state: 'no_cut'`, no tag). */
export function noCutTagResult(): CutlineTagResult {
  return {
    state: 'no_cut',
    tag: null,
    division: 'D1',
    season: null,
    course: 'SCY',
    tableCourse: 'SCY',
    swimCourse: 'SCY',
    gender: 'Men',
    event: '100 Freestyle',
    swimSeconds: null,
    lookupStatus: 'ok',
    nextTier: null,
    reason: 'fixture: judged, no cut reached',
  };
}

/**
 * A complete `Workspace`. The type requires `id`, `name`, both result lists, `recruits` and
 * `createdAt`; every other field stays absent unless the caller names it, so a test that relies
 * on a field being absent still sees it absent. A test that names a field with the wrong type or
 * a field `Workspace` does not have fails to compile, which a cast would hide.
 */
export function workspaceFixture(fields: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-fixture',
    name: 'Fixture workspace',
    menResults: [],
    womenResults: [],
    recruits: [],
    createdAt: 0,
    ...fields,
  };
}
