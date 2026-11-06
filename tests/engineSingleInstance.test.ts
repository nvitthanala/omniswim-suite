/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * E4: one module instance (plans/2026-10-25/D2-ENGINE-API.md, 2.5 E4).
 *
 * A moved module is reachable by two paths: the core shim (`packages/core/src/...`) and the engine
 * (`@omniswim/engine/...`). If a bundler or a test runner loaded the engine file twice, there would
 * be two copies of each export: a function that is not `===` to itself, an error class that fails
 * `instanceof` across paths, and module state (the user conference bindings) that one path sets and
 * the other cannot read. These tests prove there is one instance.
 */
import { describe, expect, it } from 'vitest';

import * as coreCalculatePoints from '../packages/core/src/lib/calculatePoints';
import * as coreCourseEvents from '../packages/core/src/lib/courseEvents';
import * as coreRelaySplits from '../packages/core/src/lib/relaySplits';
import * as coreScoringDefaults from '../packages/core/src/lib/scoringDefaults';
import * as coreScyConversion from '../packages/core/src/lib/scyConversion';
import * as engineCalculatePoints from '@omniswim/engine/lib/calculatePoints';
import * as engineCourseEvents from '@omniswim/engine/lib/courseEvents';
import * as engineRelaySplits from '@omniswim/engine/lib/relaySplits';
import * as engineScoringDefaults from '@omniswim/engine/lib/scoringDefaults';
import { Gender } from '../packages/core/src/types';

describe('one module instance across the core shim and the engine (D2 E4)', () => {
  it('exports the same function through both paths', () => {
    expect(coreScoringDefaults.mergeScoringSettings).toBeTypeOf('function');
    expect(coreScoringDefaults.mergeScoringSettings).toBe(engineScoringDefaults.mergeScoringSettings);
    expect(coreCalculatePoints.calculatePoints).toBeTypeOf('function');
    expect(coreCalculatePoints.calculatePoints).toBe(engineCalculatePoints.calculatePoints);
  });

  it('exports the same error class through both paths', () => {
    for (const [core, engine, name] of [
      [coreScoringDefaults.HostPublishedTableRequiredError, engineScoringDefaults.HostPublishedTableRequiredError, 'HostPublishedTableRequiredError'],
      [coreRelaySplits.RelayDistanceUnreadableError, engineRelaySplits.RelayDistanceUnreadableError, 'RelayDistanceUnreadableError'],
      [coreCourseEvents.EventNotSwumInCourseError, engineCourseEvents.EventNotSwumInCourseError, 'EventNotSwumInCourseError'],
    ] as const) {
      expect(core, name).toBeTypeOf('function');
      expect(core, name).toBe(engine);
    }
  });

  it('lets an error thrown through one path pass instanceof against the other path', () => {
    // HostPublishedTableRequiredError: a preset whose table the governing body does not publish.
    const hostPreset = coreScoringDefaults.BUILT_IN_SCORING_PRESETS.find(p => p.requiresHostPublishedTable);
    expect(hostPreset, 'a built-in preset must require a host-published table').toBeDefined();
    let host: unknown;
    try {
      coreScoringDefaults.settingsForBuiltInScoringPreset(hostPreset!.id);
    } catch (err) {
      host = err;
    }
    expect(host).toBeInstanceOf(engineScoringDefaults.HostPublishedTableRequiredError);
    expect(host).toBeInstanceOf(coreScoringDefaults.HostPublishedTableRequiredError);

    // RelayDistanceUnreadableError: a relay label that states no distance.
    let relay: unknown;
    try {
      coreRelaySplits.parseRelayDistanceYards('Relay');
    } catch (err) {
      relay = err;
    }
    expect(relay).toBeInstanceOf(engineRelaySplits.RelayDistanceUnreadableError);
    expect(relay).toBeInstanceOf(coreRelaySplits.RelayDistanceUnreadableError);

    // EventNotSwumInCourseError: a yards-only distance recorded in short-course metres.
    let course: unknown;
    try {
      coreScyConversion.convertSwimToSCY('500 Freestyle', '5:00.00', Gender.MEN, 'SCM');
    } catch (err) {
      course = err;
    }
    expect(course).toBeInstanceOf(engineCourseEvents.EventNotSwumInCourseError);
    expect(course).toBeInstanceOf(coreCourseEvents.EventNotSwumInCourseError);
  });

  it('reads a user conference binding set through core back through the engine', () => {
    const marker = 'E4SINGLEINSTANCEMARKER';
    try {
      coreScoringDefaults.setUserConferencePresetBindings([
        { id: 'e4-single-instance', label: 'E4 single instance', conferenceMatches: [marker] },
      ]);
      const seen = engineScoringDefaults.conferencePresetBindings().filter(b => b.match === marker);
      expect(seen).toStrictEqual([{ match: marker, presetId: 'e4-single-instance', builtIn: false }]);
    } finally {
      coreScoringDefaults.setUserConferencePresetBindings([]);
    }
    expect(engineScoringDefaults.conferencePresetBindings().some(b => b.match === marker)).toBe(false);
  });
});
