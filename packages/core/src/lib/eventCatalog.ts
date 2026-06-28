/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export const INDIVIDUAL_EVENTS = [
  '50 Freestyle',
  '100 Freestyle',
  '200 Freestyle',
  '500 Freestyle',
  '1000 Freestyle',
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
