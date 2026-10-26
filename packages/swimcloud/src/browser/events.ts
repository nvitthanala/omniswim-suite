/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SwimCloud's event codes (recon Q3): stroke `1` free, `2` back, `3` breast, `4` fly, `5` IM,
 * `6` free relay, `7` medley relay, `H` diving. An event id is `stroke|distance|course|legs`, and a
 * dive is `H|board|legs` with no course (`H|1|1` 1 m, `H|3|1` 3 m, `H|2|1` platform). A relay's
 * distance is the total (`7|200|Y|4` is the 200 Medley Relay).
 *
 * The event key is the engine's canonical name (`normalizeEventForCutline`), so the model and the
 * lineup agree with every other part of the engine. An unknown code throws: no event is guessed.
 */
import type { EventKey, MeetEvent } from '@omniswim/engine';
import { normalizeEventForCutline } from '@omniswim/engine/lib/cutlineEventNames';
import { AdapterError } from './simulatorTypes';

const STROKE_NAMES: Readonly<Record<string, string>> = {
  '1': 'Freestyle',
  '2': 'Backstroke',
  '3': 'Breaststroke',
  '4': 'Butterfly',
  '5': 'Individual Medley',
};

const DIVE_NAMES: Readonly<Record<number, string>> = {
  1: '1 Meter Diving',
  3: '3 Meter Diving',
  2: 'Platform Diving',
};

export type SimulatorEventShape = Omit<MeetEvent, 'gender'>;

/** The event a stroke code and distance name. `path` is where the code was read, for the error. */
export function simulatorEvent(stroke: string, distance: number, path: string): SimulatorEventShape {
  if (!Number.isInteger(distance) || distance < 1) {
    throw new AdapterError('unknown_event', path, `distance ${String(distance)} is not a positive whole number`);
  }
  if (stroke === 'H') {
    const name = DIVE_NAMES[distance];
    if (name === undefined) throw new AdapterError('unknown_event', path, `diving board code ${distance} is not 1, 2 or 3`);
    return { eventKey: normalizeEventForCutline(name), kind: 'diving', distanceYards: null, relayKind: null };
  }
  if (stroke === '6' || stroke === '7') {
    const relayKind = stroke === '7' ? 'medley' : 'freestyle';
    const name = `${distance} ${stroke === '7' ? 'Medley' : 'Freestyle'} Relay`;
    return { eventKey: normalizeEventForCutline(name), kind: 'relay', distanceYards: distance, relayKind };
  }
  const strokeName = STROKE_NAMES[stroke];
  if (strokeName === undefined) throw new AdapterError('unknown_event', path, `stroke code "${stroke}" is not 1 to 7 or H`);
  return { eventKey: normalizeEventForCutline(`${distance} ${strokeName}`), kind: 'individual', distanceYards: distance, relayKind: null };
}

export function simulatorEventKey(stroke: string, distance: number, path: string): EventKey {
  return simulatorEvent(stroke, distance, path).eventKey;
}

/** Read an `eventdistance`, which the page sends as a string or a number. */
export function readDistance(raw: string | number, path: string): number {
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(n)) throw new AdapterError('unknown_event', path, `distance "${String(raw)}" is not a whole number`);
  return n;
}
