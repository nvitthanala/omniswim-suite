/**
 * Async, single-writer JSON store for meets.json.
 *
 * All reads are async; all writes go through a serialized queue so concurrent
 * Manager/Matrix edits can never interleave a partial write and corrupt the file.
 * Writes are atomic (temp file + rename) and a rolling backup is kept.
 */
import { promises as fsp } from 'fs';
import fs from 'fs';
import path from 'path';

type Mutator<T> = (current: T) => T | Promise<T>;

export class JsonStore<T> {
  private readonly filePath: string;
  private readonly backupDir: string;
  private readonly fallback: () => T;
  private queue: Promise<unknown> = Promise.resolve();
  private cache: T | null = null;

  constructor(filePath: string, fallback: () => T, backupDir?: string) {
    this.filePath = filePath;
    this.fallback = fallback;
    this.backupDir = backupDir ?? path.join(path.dirname(filePath), 'backups');
  }

  /** Ensure the file exists, seeding it with the fallback value if missing. */
  async init(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      const seed = this.fallback();
      await this.atomicWrite(seed);
      this.cache = seed;
    }
  }

  /** Read the current value (from disk; cache kept for fast subsequent reads). */
  async read(): Promise<T> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as T;
      this.cache = parsed;
      return parsed;
    } catch (err) {
      if (this.cache != null) return this.cache;
      const seed = this.fallback();
      this.cache = seed;
      return seed;
    }
  }

  /**
   * Apply a mutation under the write lock. The mutator receives the freshest
   * on-disk value and returns the next value to persist. Returns the value
   * actually written so callers can respond with it.
   */
  async mutate(mutator: Mutator<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const current = await this.read();
      const next = await mutator(current);
      await this.atomicWrite(next);
      this.cache = next;
      return next;
    });
    // Keep the chain alive even if this mutation rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Write a JSON snapshot to the backup directory (timestamped). */
  async backup(label = 'manual'): Promise<string> {
    const value = await this.read();
    await fsp.mkdir(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.backupDir, `${path.basename(this.filePath, '.json')}-${label}-${stamp}.json`);
    await fsp.writeFile(dest, JSON.stringify(value, null, 2), 'utf-8');
    await this.pruneBackups(20);
    return dest;
  }

  private async pruneBackups(keep: number): Promise<void> {
    try {
      const entries = (await fsp.readdir(this.backupDir))
        .filter(f => f.endsWith('.json'))
        .sort();
      if (entries.length <= keep) return;
      const stale = entries.slice(0, entries.length - keep);
      await Promise.all(stale.map(f => fsp.unlink(path.join(this.backupDir, f)).catch(() => undefined)));
    } catch {
      /* backup dir may not exist yet */
    }
  }

  private async atomicWrite(value: T): Promise<void> {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
    await fsp.rename(tmp, this.filePath);
  }
}
