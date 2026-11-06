/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every individual event a coach can plan an entry in.
 *
 * ## Both courses, in distance order
 *
 * The list mixes short-course-yards and long-course-metres distances on
 * purpose: 500/1000/1650 are yards events, 400/800/1500 are metres events, and
 * a coach plans in whichever course the meet is contested in. Filtering by
 * course would mean this list had to know the meet's course, which it does not
 * and should not.
 *
 * **800 and 1500 Freestyle were added on 2026-09-22.** `CONVERSION_FACTORS` in
 * `../constants.ts` already knew both, so the app could convert a time it gave
 * no way to enter — a coach planning a long-course meet could not pick either
 * of the two signature distance events. Anything the conversion table knows
 * belongs here.
 */
export const INDIVIDUAL_EVENTS = [
  '50 Freestyle',
  '100 Freestyle',
  '200 Freestyle',
  '400 Freestyle',
  '500 Freestyle',
  '800 Freestyle',
  '1000 Freestyle',
  '1500 Freestyle',
  '1650 Freestyle',
  '100 Backstroke',
  '200 Backstroke',
  '100 Breaststroke',
  '200 Breaststroke',
  '100 Butterfly',
  '200 Butterfly',
  '200 IM',
  '400 IM',
  '1M Diving',
  '3M Diving',
  'Platform Diving',
] as const;

export const RELAY_SPLIT_EVENTS = [
  '50 Freestyle (Relay split)',
  '100 Freestyle (Relay split)',
] as const;

export const ALL_PLAN_EVENTS = [...INDIVIDUAL_EVENTS, ...RELAY_SPLIT_EVENTS] as const;
