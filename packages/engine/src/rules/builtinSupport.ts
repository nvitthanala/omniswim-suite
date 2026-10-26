/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Small constructors shared by the three built-in files. Internal: not exported from the package
 * root. Each helper only builds a record; none supplies a value.
 */
import type { Provenance, Setting } from '../model/provenance';

/** A built-in: code, addressed by `{kind: 'builtin', id, version}`, never seeded into storage. */
export interface Builtin<P> {
  readonly id: string;
  /** Raise it whenever the content changes. `tests/engineBuiltinVersions.test.ts` enforces that. */
  readonly version: number;
  readonly label: string;
  readonly preset: P;
}

/** The user's plan, stated 2026-10-25 (verbatim). */
export const USER_PLAN_PATH = 'plans/2026-10-25/00-USER-PLAN.md';
/** The decision rows R1 to R44, paraphrases of what the user said. */
export const README_PATH = 'plans/2026-10-25/README.md';
export const STATED_ON = '2026-10-25';

/** A value quoted from the user plan. `where` is `path:line`. */
export function userPlan(line: string, wording: string): Provenance {
  return { kind: 'user-stated', statedOn: STATED_ON, wording, where: `${USER_PLAN_PATH}:${line}`, verbatim: true };
}

/** A value the README decision rows paraphrase. `line` is a line, a comma list or a range. */
export function readmeRow(line: string, wording: string): Provenance {
  return { kind: 'user-stated', statedOn: STATED_ON, wording, where: `${README_PATH}:${line}`, verbatim: false };
}

/** A paraphrase recorded in a repo file other than the plan. `where` is `path:line`. */
export function recorded(statedOn: string, where: string, wording: string): Provenance {
  return { kind: 'user-stated', statedOn, wording, where, verbatim: false };
}

export function setting<T>(value: T, provenance: Provenance): Setting<T> {
  return { state: 'set', value, provenance };
}

export function pending<T>(question: string, blocks: readonly string[]): Setting<T> {
  return { state: 'pending', question, blocks: [...blocks] };
}
