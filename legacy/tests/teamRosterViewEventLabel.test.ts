/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P16: an AthleteEventProfile's `primaryEvents`/`bestByEvent` keys are now the
 * raw HyTek label a swim was recorded with ("Event 4 Men 1000 Yard
 * Freestyle"), not a pre-shortened display string. `formatEventLabelForDisplay`
 * is the roster panel's only place that turns that key into something a coach
 * reads, built on core's own `canonicalMeetEventLabel`/`normalizeEventLabel`
 * rather than re-deriving event identity.
 */
import { describe, expect, it } from 'vitest';
import { formatEventLabelForDisplay } from '../packages/manager/src/components/teamRosterView';

describe('formatEventLabelForDisplay', () => {
  it('shortens a HyTek yard label to a compact name with an SCY course tag', () => {
    expect(formatEventLabelForDisplay('Event 4 Men 1000 Yard Freestyle')).toBe('1000 Free (SCY)');
  });

  it('abbreviates every stroke', () => {
    expect(formatEventLabelForDisplay('Event 24 Men 100 Yard Backstroke')).toBe('100 Back (SCY)');
    expect(formatEventLabelForDisplay('Event 10 Women 100 Yard Breaststroke')).toBe('100 Breast (SCY)');
    expect(formatEventLabelForDisplay('Event 6 Men 100 Yard Butterfly')).toBe('100 Fly (SCY)');
    expect(formatEventLabelForDisplay('Event 20 Women 200 Yard Individual Medley')).toBe('200 IM (SCY)');
  });

  it('tags an unambiguous long-course-meters label as LCM', () => {
    expect(formatEventLabelForDisplay('400 LCM Freestyle')).toBe('400 Free (LCM)');
  });

  it('leaves an ambiguous bare "Meter" label untagged rather than guessing SCM/LCM', () => {
    expect(formatEventLabelForDisplay('400 Meter Freestyle')).toBe('400 Free');
  });

  it('already-compact labels pass through unchanged (no double-shortening)', () => {
    expect(formatEventLabelForDisplay('100 Backstroke')).toBe('100 Back');
  });
});
