import type { HTMLAttributes } from 'react';
import { ArrowLeftRight, HelpCircle, TrendingDown } from 'lucide-react';
import type { CutlineNextTierGap, CutlineTagResult } from '@omniswim/core/lib/cutlineTags';
import { cutlineTagRenderMode, describeCutlineTagResult } from '@omniswim/core/lib/cutlineTags';
import { Badge } from './Badge';

/**
 * Tone per published tier. D1 has no A/B split (`Standard`); NAIA prints
 * `AUTO`/`PROV`, carried here under the same underlying `A`/`B` tier the core
 * `CutlineTag` assigns them (`cutlineTierNaming` handles the wording, this
 * only maps to a color).
 */
const TIER_TONE: Record<string, 'accent' | 'warning' | 'info'> = {
  A: 'accent',
  Standard: 'accent',
  Qualifying: 'accent',
  B: 'warning',
  Provisional: 'warning',
  Invited: 'info',
};

type CutlineTagProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  result: CutlineTagResult;
  /**
   * Smaller inline chip for dense tables/rows where the full uppercase pill
   * would crowd a time cell. Same four render states, just tighter padding
   * and (for the unknown state) an icon instead of the word "Unknown". The
   * indicative state keeps its full label even when compact — the whole
   * point is legibility, not just a hint icon.
   */
  compact?: boolean;
};

/**
 * Renders a `CutlineTagResult` in one of the four states a caller must
 * distinguish — see `cutlineTagRenderMode` in `@omniswim/core/lib/cutlineTags`:
 *
 * - `'tag'` — the achieved-cut badge, from `tag.label` / `tag.title`. Solid
 *   fill.
 * - `'no_cut'` — a genuine, judged miss. Renders nothing.
 * - `'indicative'` — a metric (LCM/SCM) swim whose *converted* yards time
 *   clears a standard. Real information, but never a cut — only a yards swim
 *   earns one. Rendered as an outline/ghost chip (transparent fill, dashed
 *   border, italic, conversion icon) in the tier's own color, so it reads as
 *   "close, not earned" rather than "unknown" or "achieved".
 * - `'unknown'` — unjudgeable (no table, division unknown, event not
 *   published, no time). Renders a muted, neutral-gray affordance, never
 *   silence and never a cut badge.
 */
export function CutlineTag({ result, compact = false, className, ...props }: CutlineTagProps) {
  const mode = cutlineTagRenderMode(result);
  if (mode === 'no_cut') return null;

  const tooltip = describeCutlineTagResult(result);
  const sizeClass = compact ? 'px-1.5 py-0.5 text-[0.65rem] gap-0.5' : '';
  const classes = [sizeClass, className].filter(Boolean).join(' ');

  if (mode === 'indicative' && result.state === 'converted_estimate') {
    const { indicative } = result;
    const tone = TIER_TONE[indicative.tier] ?? 'neutral';
    return (
      <Badge
        tone={tone}
        title={tooltip}
        className={['badge-indicative', classes].filter(Boolean).join(' ')}
        {...props}
      >
        <ArrowLeftRight size={compact ? 9 : 11} aria-hidden="true" />
        {indicative.label}
      </Badge>
    );
  }

  if (mode === 'unknown' || result.state !== 'tagged') {
    return (
      <Badge
        tone="neutral"
        title={tooltip}
        className={['border-dashed opacity-70', classes].filter(Boolean).join(' ')}
        {...props}
      >
        <HelpCircle size={compact ? 9 : 11} aria-hidden="true" />
        {compact ? null : 'Unknown'}
      </Badge>
    );
  }

  const tag = result.tag;
  const tone = TIER_TONE[tag.tier] ?? 'neutral';
  return (
    <Badge tone={tone} title={tooltip} className={classes} {...props}>
      {tag.label}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/* Near-miss chip                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How close a miss has to be — as a fraction of the published standard's own
 * seconds — before {@link CutlineNearMissChip} will show it.
 *
 * Core deliberately has no opinion here (`CutlineNextTierGap` is pure
 * subtraction); "is this close?" is a presentation call, so it lives in the UI
 * layer as a named constant rather than a number buried in a conditional.
 *
 * Relative, not absolute: 0.03s off a 19.39s sprint (0.15%) and 2.79s off a
 * 3:12.45 relay (1.45%) are both genuinely close; 2.79s off a 50 Free would
 * not be. A flat seconds cutoff cannot honor that, so this is expressed as a
 * fraction of `standardSeconds`.
 *
 * ## Why a pure percentage is the correct scaling
 *
 * A flat "or 1 second" floor was considered and rejected on the data. Measured
 * against every published D2 men's standard, a 1s floor **only ever binds on the
 * 50 Freestyle** — every other event's 2.5% window is already wider than a
 * second (100 Free 1.13s, 200 Free 2.47s, 1650 23.86s). So it is not a general
 * scaling rule; it is a special case for exactly one event.
 *
 * And on that one event it does harm. The 50 Free A/B standards are 19.39 and
 * 20.36 — a **0.97s** gap. A 1s window is therefore *wider than the entire tier
 * gap*, so every swimmer who earned a B would also be flagged as "near" the A.
 * The chip would restate the badge instead of adding to it.
 *
 * The deeper reason a percentage just works: the NCAA's own tier spacing is
 * itself proportional. The A→B gap is ~4.7% of the standard on every event, so
 * 2.5% lands at a near-constant ~53% of one tier gap across the whole program —
 * 0.51s of 0.97s in the 50 Free, 1.22s of 2.31s in the 100 Back, 23.86s of
 * 45.44s in the 1650. The scale problem the absolute floor was meant to fix does
 * not exist, because the standards are already scaled.
 *
 * Tuning guidance: stay below ~4.7%. At that point the window equals a full tier
 * gap and the chip becomes redundant with the badge. Every caller reads this
 * constant; none hardcodes its own threshold.
 */
export const NEAR_MISS_RELATIVE_THRESHOLD = 0.025;

function isWithinNearMissThreshold(gap: CutlineNextTierGap): boolean {
  return gap.standardSeconds > 0 && gap.shortBySeconds / gap.standardSeconds <= NEAR_MISS_RELATIVE_THRESHOLD;
}

type CutlineNearMissChipProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  /** `CutlineTagResult['nextTier']` — absent-never-zero, see core's `cutlineTags`. */
  nextTier: CutlineNextTierGap | null;
  /** Tighter padding/type for dense table rows, matching `CutlineTag`'s `compact`. */
  compact?: boolean;
};

/**
 * Renders how far a swim fell short of the next published tier it did not
 * reach — e.g. `−0.33 → D2 PROVISIONAL`.
 *
 * This is a deficit, never an award, and must not be mistaken for one:
 * no pill, no fill, no border — just small muted italic text with a
 * downward-trend glyph, deliberately subordinate to a real `CutlineTag`
 * badge when both render side by side.
 *
 * Renders nothing when `nextTier` is `null` (nothing to report) or when the
 * gap is wider than {@link NEAR_MISS_RELATIVE_THRESHOLD} (not a near miss).
 */
export function CutlineNearMissChip({
  nextTier,
  compact = false,
  className,
  ...props
}: CutlineNearMissChipProps) {
  if (!nextTier || !isWithinNearMissThreshold(nextTier)) return null;

  const tooltip = `${nextTier.tierName} standard for ${nextTier.event}: ${nextTier.standardTime}`;
  const sizeClass = compact ? 'text-[0.65rem] gap-0.5' : 'text-ui-micro gap-1';

  return (
    <span
      className={[
        'inline-flex items-center font-mono italic text-theme-muted opacity-80',
        sizeClass,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title={tooltip}
      {...props}
    >
      <TrendingDown size={compact ? 9 : 11} aria-hidden="true" className="shrink-0" />
      {'−'}
      {nextTier.shortBySeconds.toFixed(2)} {'→'} {nextTier.label}
    </span>
  );
}
