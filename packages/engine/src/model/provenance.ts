/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Provenance and settings (plans/2026-10-25/D2-ENGINE-API.md, 3.2).
 *
 * Every value a rule preset holds carries where it came from, or it is `pending`. A pending
 * setting has no `value` field, so no code can read a guess. The parser accepts five provenance
 * kinds only. `'legacy'` is banned (CLAUDE.md, data provenance).
 *
 * `'engine-neutral'` (P2, 2026-10-26) is for a value no source states: a neutral value a preset must
 * hold so it is complete, for a setting the preset's mode never reads. It is not a claim about any rule.
 *
 * `'tool-derived'` (R58, 2026-10-26) is for a value fitted to the outputs of a third-party tool that
 * publishes no source. It is never `published`: no code may render it, count it or store it as one.
 */
import { RulePresetError } from '../rules/cap';
import type { IsoDate, IsoTime } from './primitives';

export type SourceRef = {
  /** Id inside a `data/**` `sources/manifest.json`. */
  readonly sourceId: string;
  /** Repo path of that manifest, e.g. `data/scoring_rules/sources/manifest.json`. */
  readonly manifest: string;
  readonly sha256: string;
  readonly url: string;
  /** `'NCAA'`, `'NAIA'`, `'SwimCloud meet simulator'`. */
  readonly publisher: string;
  /** `'Rule 7-6-4'`, `'p. 2'`. */
  readonly locator?: string;
};

export type Provenance =
  | { readonly kind: 'published'; readonly source: SourceRef }
  | {
      readonly kind: 'user-stated';
      readonly statedOn: IsoDate;
      readonly wording: string;
      /** `path:line` of the record. A comma list or a range (`a-b`) names several lines. */
      readonly where: string;
      /** `false`: a paraphrase (the README decision rows). */
      readonly verbatim: boolean;
    }
  | { readonly kind: 'user-edited'; readonly editedAt: IsoTime; readonly previous: Provenance | null }
  | {
      readonly kind: 'engine-neutral';
      /** Why the setting exists and why the value does not matter here. Not a source. */
      readonly reason: string;
    }
  | {
      readonly kind: 'tool-derived';
      /** The tool whose outputs the value was fitted to. */
      readonly tool: { readonly name: string; readonly url: string };
      /** The archived record of those outputs. `sha256` is the sha256 of the file at `path`. */
      readonly archive: { readonly path: string; readonly sha256: string };
      readonly capturedOn: IsoDate;
      /** Fixed text. The value is an inference from outputs: the tool publishes no factors. */
      readonly basis: 'inferred-from-tool-outputs';
    };

export type Setting<T> =
  | { readonly state: 'set'; readonly value: T; readonly provenance: Provenance }
  | { readonly state: 'pending'; readonly question: string; readonly blocks: readonly string[] };

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws `invalid` when `raw` is not an object, or `missing`/`invalid` for a wrong key set. */
export function expectKeys(
  raw: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!isRecord(raw)) throw new RulePresetError(path, 'invalid', `${path}: expected an object`);
  for (const key of required) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) {
      throw new RulePresetError(`${path}.${key}`, 'missing', `${path}.${key}: missing`);
    }
  }
  for (const key of Object.keys(raw)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new RulePresetError(`${path}.${key}`, 'invalid', `${path}.${key}: unknown key`);
    }
  }
  return raw;
}

export function expectString(raw: unknown, path: string, allowEmpty = false): string {
  if (typeof raw !== 'string' || (!allowEmpty && raw.trim() === '')) {
    throw new RulePresetError(path, 'invalid', `${path}: expected a non-empty string`);
  }
  return raw;
}

export function expectIsoDate(raw: unknown, path: string): IsoDate {
  const text = expectString(raw, path);
  if (!ISO_DATE.test(text)) throw new RulePresetError(path, 'invalid', `${path}: not a YYYY-MM-DD date`);
  return text;
}

export function expectIsoTime(raw: unknown, path: string): IsoTime {
  const text = expectString(raw, path);
  if (!ISO_TIME.test(text)) throw new RulePresetError(path, 'invalid', `${path}: not an ISO instant`);
  return text;
}

/** Parse a provenance record. Any `kind` outside the five throws; `'legacy'` throws `legacy_provenance`. */
export function parseProvenance(raw: unknown, path: string): Provenance {
  if (!isRecord(raw)) throw new RulePresetError(path, 'invalid', `${path}: expected an object`);
  const kind = raw.kind;
  if (kind === 'legacy') {
    throw new RulePresetError(path, 'legacy_provenance', `${path}: provenance kind "legacy" is banned`);
  }
  if (kind === 'published') {
    const obj = expectKeys(raw, path, ['kind', 'source']);
    const src = expectKeys(obj.source, `${path}.source`, ['sourceId', 'manifest', 'sha256', 'url', 'publisher'], ['locator']);
    const sha256 = expectString(src.sha256, `${path}.source.sha256`);
    if (!SHA256.test(sha256)) {
      throw new RulePresetError(`${path}.source.sha256`, 'invalid', `${path}.source.sha256: not a lowercase sha256`);
    }
    return {
      kind: 'published',
      source: {
        sourceId: expectString(src.sourceId, `${path}.source.sourceId`),
        manifest: expectString(src.manifest, `${path}.source.manifest`),
        sha256,
        url: expectString(src.url, `${path}.source.url`),
        publisher: expectString(src.publisher, `${path}.source.publisher`),
        ...(src.locator === undefined ? {} : { locator: expectString(src.locator, `${path}.source.locator`) }),
      },
    };
  }
  if (kind === 'user-stated') {
    const obj = expectKeys(raw, path, ['kind', 'statedOn', 'wording', 'where', 'verbatim']);
    if (typeof obj.verbatim !== 'boolean') {
      throw new RulePresetError(`${path}.verbatim`, 'invalid', `${path}.verbatim: expected a boolean`);
    }
    return {
      kind: 'user-stated',
      statedOn: expectIsoDate(obj.statedOn, `${path}.statedOn`),
      wording: expectString(obj.wording, `${path}.wording`),
      where: expectString(obj.where, `${path}.where`),
      verbatim: obj.verbatim,
    };
  }
  if (kind === 'user-edited') {
    const obj = expectKeys(raw, path, ['kind', 'editedAt', 'previous']);
    return {
      kind: 'user-edited',
      editedAt: expectIsoTime(obj.editedAt, `${path}.editedAt`),
      previous: obj.previous === null ? null : parseProvenance(obj.previous, `${path}.previous`),
    };
  }
  if (kind === 'engine-neutral') {
    const obj = expectKeys(raw, path, ['kind', 'reason']);
    return { kind: 'engine-neutral', reason: expectString(obj.reason, `${path}.reason`) };
  }
  if (kind === 'tool-derived') {
    const obj = expectKeys(raw, path, ['kind', 'tool', 'archive', 'capturedOn', 'basis']);
    const tool = expectKeys(obj.tool, `${path}.tool`, ['name', 'url']);
    const archive = expectKeys(obj.archive, `${path}.archive`, ['path', 'sha256']);
    const sha256 = expectString(archive.sha256, `${path}.archive.sha256`);
    if (!SHA256.test(sha256)) {
      throw new RulePresetError(`${path}.archive.sha256`, 'invalid', `${path}.archive.sha256: not a lowercase sha256`);
    }
    if (obj.basis !== 'inferred-from-tool-outputs') {
      throw new RulePresetError(`${path}.basis`, 'invalid', `${path}.basis: expected "inferred-from-tool-outputs"`);
    }
    return {
      kind: 'tool-derived',
      tool: { name: expectString(tool.name, `${path}.tool.name`), url: expectString(tool.url, `${path}.tool.url`) },
      archive: { path: expectString(archive.path, `${path}.archive.path`), sha256 },
      capturedOn: expectIsoDate(obj.capturedOn, `${path}.capturedOn`),
      basis: 'inferred-from-tool-outputs',
    };
  }
  throw new RulePresetError(path, 'invalid', `${path}: unknown provenance kind ${JSON.stringify(kind)}`);
}

/** Parse a setting. `parseValue` reads the value of a `set` setting and must throw on a bad one. */
export function parseSetting<T>(raw: unknown, path: string, parseValue: (value: unknown, path: string) => T): Setting<T> {
  if (!isRecord(raw)) throw new RulePresetError(path, 'invalid', `${path}: expected an object`);
  if (raw.state === 'set') {
    const obj = expectKeys(raw, path, ['state', 'value', 'provenance']);
    return {
      state: 'set',
      value: parseValue(obj.value, `${path}.value`),
      provenance: parseProvenance(obj.provenance, `${path}.provenance`),
    };
  }
  if (raw.state === 'pending') {
    const obj = expectKeys(raw, path, ['state', 'question', 'blocks']);
    if (!Array.isArray(obj.blocks) || obj.blocks.some(b => typeof b !== 'string')) {
      throw new RulePresetError(`${path}.blocks`, 'invalid', `${path}.blocks: expected a list of strings`);
    }
    return {
      state: 'pending',
      question: expectString(obj.question, `${path}.question`),
      blocks: [...(obj.blocks as string[])],
    };
  }
  throw new RulePresetError(path, 'invalid', `${path}.state: expected "set" or "pending"`);
}

/**
 * The provenance of a value a user has just edited. Never an upgrade: the old provenance is kept
 * as `previous`, so a published value that was edited reads as edited, not as published.
 */
export function editedProvenance(previous: Provenance | null, editedAt: IsoTime): Provenance {
  if (!ISO_TIME.test(editedAt)) {
    throw new RangeError(`editedProvenance: "${editedAt}" is not an ISO instant`);
  }
  return { kind: 'user-edited', editedAt, previous };
}
