/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the per-workspace save lock and the header parser.
 */
import { describe, expect, it } from 'vitest';
import { SaveSequencer, parseSaveToken } from '../apps/shell/lib/saveSequencer';
import { SAVE_CLIENT_HEADER, SAVE_SEQ_HEADER } from '../packages/core/src/api/saveSequence';

const tok = (seq: number, clientId = 'client-aaaaaaaa') => ({ clientId, seq });
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('SaveSequencer', () => {
  it('runs saves for one key one at a time, in arrival order', async () => {
    const s = new SaveSequencer();
    const log: string[] = [];
    const slow = s.run('k', tok(1), async () => {
      log.push('1:start');
      await delay(30);
      log.push('1:end');
      return 1;
    });
    const fast = s.run('k', tok(2), async () => {
      log.push('2:start');
      log.push('2:end');
      return 2;
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual(['1:start', '1:end', '2:start', '2:end']);
  });

  it('a save queued behind a newer one is refused once the newer one has applied', async () => {
    const s = new SaveSequencer();
    const applied: number[] = [];
    // 2 arrives first and is slow; 1 arrives while 2 is still writing.
    const two = s.run('k', tok(2), async () => {
      await delay(20);
      applied.push(2);
      return 2;
    });
    const one = s.run('k', tok(1), async () => {
      applied.push(1);
      return 1;
    });
    const [r2, r1] = await Promise.all([two, one]);
    expect(r2.status).toBe('applied');
    expect(r1).toEqual({ status: 'stale', lastAppliedSeq: 2, receivedSeq: 1 });
    expect(applied).toEqual([2]);
  });

  it('a failed write does not record the sequence', async () => {
    const s = new SaveSequencer();
    await expect(
      s.run('k', tok(3), async () => {
        throw new Error('disk full');
      })
    ).rejects.toThrow('disk full');
    expect(s.peek('k')).toBeUndefined();
    // The lock is not poisoned, and the same number may be retried.
    const retry = await s.run('k', tok(3), async () => 'ok');
    expect(retry.status).toBe('applied');
  });

  it('keys are independent', async () => {
    const s = new SaveSequencer();
    await s.run('a', tok(5), async () => 1);
    const other = await s.run('b', tok(1), async () => 1);
    expect(other.status).toBe('applied');
  });

  it('bounds memory: the least recently written key is forgotten first', async () => {
    const s = new SaveSequencer(2);
    await s.run('a', tok(1), async () => 1);
    await s.run('b', tok(1), async () => 1);
    await s.run('c', tok(1), async () => 1);
    expect(s.peek('a')).toBeUndefined();
    expect(s.peek('b')).toBeDefined();
    expect(s.peek('c')).toBeDefined();
  });
});

describe('parseSaveToken', () => {
  const h = (client?: string, seq?: string) => ({
    ...(client !== undefined ? { [SAVE_CLIENT_HEADER.toLowerCase()]: client } : {}),
    ...(seq !== undefined ? { [SAVE_SEQ_HEADER.toLowerCase()]: seq } : {}),
  });
  it('absent when neither header is sent', () => {
    expect(parseSaveToken({})).toEqual({ kind: 'absent' });
  });
  it('parses a valid pair', () => {
    expect(parseSaveToken(h('abc12345-x', '12'))).toEqual({
      kind: 'ok',
      token: { clientId: 'abc12345-x', seq: 12 },
    });
  });
  it.each([
    [h('abc12345-x')],
    [h(undefined, '3')],
    [h('abc12345-x', '0')],
    [h('abc12345-x', '01')],
    [h('abc12345-x', '1e3')],
    [h('short', '1')],
    [h('bad id with spaces', '1')],
    [{ [SAVE_CLIENT_HEADER.toLowerCase()]: ['a', 'b'], [SAVE_SEQ_HEADER.toLowerCase()]: '1' }],
  ])('invalid: %j', headers => {
    expect(parseSaveToken(headers as never).kind).toBe('invalid');
  });
});
