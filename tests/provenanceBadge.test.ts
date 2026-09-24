// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The shared provenance badge (P6, plans/2026-09-22 continuation): every
 * athlete view that shows a swim or a best time must mark an extracted
 * split, a self-reported time, an altitude-adjusted time, and an estimate
 * converted from a metric swim — with a tooltip that names the source time
 * and the conversion basis rather than a bare "converted".
 */
import { describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  buildProvenanceBadges,
  describeConversionBasis,
  ProvenanceBadges,
} from '../packages/ui/src/components/ProvenanceBadge';
import type { ScyConversionProvenance } from '../packages/core/src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LCM_CONVERSION: ScyConversionProvenance = {
  sourceCourse: 'LCM',
  sourceEvent: '100 Back LCM',
  sourceTime: '56.28',
  scyTime: '47.56',
  basis: { method: 'lcm_factor_table', factor: 0.845, factorEvent: '100 Backstroke' },
};

const SCM_CONVERSION: ScyConversionProvenance = {
  sourceCourse: 'SCM',
  sourceEvent: '100 Breast SCM',
  sourceTime: '54.49',
  scyTime: '48.82',
  basis: {
    method: 'ncaa_scm_table',
    factor: 0.896,
    factorEvent: '100 Breaststroke',
    row: 'allOtherEvents',
    tableId: 'ncaa-rules-book-a2-2026-27',
    division: 'D2',
    reason: 'division_publishes_table',
  } as ScyConversionProvenance['basis'],
};

describe('buildProvenanceBadges', () => {
  it('is empty for a plain result with no provenance flags', () => {
    expect(buildProvenanceBadges({})).toStrictEqual([]);
  });

  it('flags an extracted split (both the bridge flag and the pasted badge)', () => {
    expect(buildProvenanceBadges({ isExtractedSplit: true }).map((b) => b.key)).toStrictEqual(['extracted']);
    expect(buildProvenanceBadges({ swimcloudBadge: 'extracted' }).map((b) => b.key)).toStrictEqual(['extracted']);
  });

  it('flags a self-reported time (both the bridge flag and the pasted badge)', () => {
    expect(buildProvenanceBadges({ isUserInputted: true }).map((b) => b.key)).toStrictEqual(['self_reported']);
    expect(buildProvenanceBadges({ swimcloudBadge: 'user_input' }).map((b) => b.key)).toStrictEqual([
      'self_reported',
    ]);
  });

  it('flags an altitude-adjusted time under either field spelling', () => {
    expect(buildProvenanceBadges({ isAltitudeAdjusted: true }).map((b) => b.key)).toStrictEqual([
      'altitude_adjusted',
    ]);
    expect(buildProvenanceBadges({ altitudeAdjusted: true }).map((b) => b.key)).toStrictEqual([
      'altitude_adjusted',
    ]);
  });

  it('labels an LCM-converted estimate "Est. from LCM" with a full tooltip', () => {
    const [badge] = buildProvenanceBadges({ convertedFrom: LCM_CONVERSION });
    expect(badge.key).toBe('converted_lcm');
    expect(badge.label).toBe('Est. from LCM');
    expect(badge.tooltip).toBe('LCM 56.28 → SCY 47.56, Colorado Time Systems factor (estimate)');
  });

  it('labels an SCM-converted estimate "Est. from SCM" with the NCAA table and division', () => {
    const [badge] = buildProvenanceBadges({ convertedFrom: SCM_CONVERSION });
    expect(badge.key).toBe('converted_scm');
    expect(badge.label).toBe('Est. from SCM');
    expect(badge.tooltip).toBe('SCM 54.49 → 48.82, NCAA Rules Book A-2 (2026-27) (D2)');
  });

  it('stacks every applicable badge on one swim, extracted/self-reported first', () => {
    const keys = buildProvenanceBadges({
      isExtractedSplit: true,
      isAltitudeAdjusted: true,
      convertedFrom: LCM_CONVERSION,
    }).map((b) => b.key);
    expect(keys).toStrictEqual(['extracted', 'altitude_adjusted', 'converted_lcm']);
  });
});

describe('describeConversionBasis', () => {
  it('matches the brief\'s worked LCM example', () => {
    expect(describeConversionBasis(LCM_CONVERSION)).toBe(
      'LCM 56.28 → SCY 47.56, Colorado Time Systems factor (estimate)'
    );
  });

  it('matches the brief\'s worked SCM example', () => {
    expect(describeConversionBasis(SCM_CONVERSION)).toContain('SCM 54.49 → 48.82, NCAA Rules Book A-2');
    expect(describeConversionBasis(SCM_CONVERSION)).toContain('(D2)');
  });
});

describe('<ProvenanceBadges>', () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (swim: Parameters<typeof ProvenanceBadges>[0]['swim']) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(ProvenanceBadges, { swim }));
    });
  };

  const cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  it('renders nothing for a swim with no provenance flags', () => {
    render({});
    expect(container.textContent).toBe('');
    cleanup();
  });

  it('renders an "Extracted" chip for an extracted split', () => {
    render({ isExtractedSplit: true });
    expect(container.textContent).toContain('Extracted');
    cleanup();
  });

  it('renders a "Self-reported" chip for a user-inputted time', () => {
    render({ isUserInputted: true });
    expect(container.textContent).toContain('Self-reported');
    cleanup();
  });

  it('renders an "Altitude-adj." chip for an altitude-adjusted time', () => {
    render({ isAltitudeAdjusted: true });
    expect(container.textContent).toContain('Altitude-adj.');
    cleanup();
  });

  it('renders "Est. from LCM" / "Est. from SCM" for converted times', () => {
    render({ convertedFrom: LCM_CONVERSION });
    expect(container.textContent).toContain('Est. from LCM');
    cleanup();
    render({ convertedFrom: SCM_CONVERSION });
    expect(container.textContent).toContain('Est. from SCM');
    cleanup();
  });
});
