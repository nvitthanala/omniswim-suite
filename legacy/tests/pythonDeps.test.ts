/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * S2: Python dependencies are pinned and installed from `backend/requirements.txt`
 * (`apps/shell/lib/pythonEnv.ts`), plus the report-only `npm audit` CI step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensurePythonEnv,
  PythonDepsError,
  readPinnedVersion,
  type EnsurePythonEnvOptions,
} from '../apps/shell/lib/pythonEnv';

const root = path.join(import.meta.dirname, '../..');
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('backend/requirements.txt', () => {
  it('pins pdfplumber to an exact version', () => {
    const text = read('legacy', 'backend', 'requirements.txt');
    expect(readPinnedVersion(text)).toMatch(/^\d+\.\d+\.\d+$/);
    const active = text
      .split(/\r?\n/)
      .map(line => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
    expect(active.some(line => /^pdfplumber==\d+\.\d+\.\d+$/.test(line))).toBe(true);
    expect(active.some(line => /[<>~]=?/.test(line))).toBe(false);
  });

  it('readPinnedVersion refuses a range, an unpinned name and a missing file entry', () => {
    expect(() => readPinnedVersion('pdfplumber>=0.11\n')).toThrow(/exact version/);
    expect(() => readPinnedVersion('pdfplumber\n')).toThrow(/exact version/);
    expect(() => readPinnedVersion('# pdfplumber==0.11.10\n')).toThrow(/exact version/);
    expect(() => readPinnedVersion('requests==2.0.0\n')).toThrow(/exact version/);
    expect(readPinnedVersion('# note\r\nPDFPlumber == 0.11.10  # pin\r\n')).toBe('0.11.10');
  });
});

describe('ensurePythonEnv', () => {
  const PIN = '0.11.10';
  const REQUIREMENTS = `pdfplumber==${PIN}\n`;

  interface Scenario {
    venvExists?: boolean;
    venvUsable?: boolean;
    installed?: string | null;
    noAutoInstall?: boolean;
  }

  function run(s: Scenario) {
    const commands: string[] = [];
    let venvExists = s.venvExists ?? true;
    let installed: string | null = s.installed === undefined ? PIN : s.installed;
    const options: EnsurePythonEnvOptions = {
      projectRoot: path.join(path.sep, 'proj'),
      platform: 'linux',
      noAutoInstall: s.noAutoInstall ?? false,
      fs: {
        existsSync: () => venvExists,
        readFileSync: (() => REQUIREMENTS) as never,
        rmSync: () => {
          venvExists = false;
        },
      },
      exec: command => {
        commands.push(command);
        if (command.includes('-m venv')) {
          venvExists = true;
          return '';
        }
        if (command.includes('import sys')) {
          if (s.venvUsable === false && !commands.some(c => c.includes('-m venv'))) throw new Error('broken venv');
          return '';
        }
        if (command.includes('importlib.metadata')) {
          if (installed === null) throw new Error('PackageNotFoundError');
          return `${installed}\n`;
        }
        if (command.includes('pip install')) {
          installed = PIN;
          return '';
        }
        throw new Error(`unexpected command ${command}`);
      },
    };
    let error: unknown;
    try {
      ensurePythonEnv(options);
    } catch (err) {
      error = err;
    }
    return { commands, error };
  }

  const pipCalls = (commands: string[]) => commands.filter(c => c.includes('pip install'));

  it('installs nothing when the pinned version is already there', () => {
    const { commands, error } = run({});
    expect(error).toBeUndefined();
    expect(pipCalls(commands)).toHaveLength(0);
  });

  it('installs from the requirements file, never by bare package name', () => {
    const { commands, error } = run({ installed: null });
    expect(error).toBeUndefined();
    const pip = pipCalls(commands);
    expect(pip).toHaveLength(1);
    expect(pip[0]).toContain('-r');
    expect(pip[0]).toContain(path.join('legacy', 'backend', 'requirements.txt'));
    expect(pip[0]).not.toMatch(/install pdfplumber/);
  });

  it('reinstalls when the installed version is not the pinned one', () => {
    const { commands, error } = run({ installed: '0.11.9' });
    expect(error).toBeUndefined();
    expect(pipCalls(commands)).toHaveLength(1);
  });

  it('creates a missing venv and then installs', () => {
    const { commands, error } = run({ venvExists: false, installed: null });
    expect(error).toBeUndefined();
    expect(commands.some(c => c.includes('-m venv'))).toBe(true);
    expect(pipCalls(commands)).toHaveLength(1);
  });

  it('with OMNI_NO_AUTO_INSTALL, refuses to install a missing package and says why', () => {
    const { commands, error } = run({ installed: null, noAutoInstall: true });
    expect(error).toBeInstanceOf(PythonDepsError);
    expect(String((error as Error).message)).toMatch(/OMNI_NO_AUTO_INSTALL=1 forbids installing/);
    expect(String((error as Error).message)).toMatch(new RegExp(`pinned: ${PIN}`));
    expect(pipCalls(commands)).toHaveLength(0);
  });

  it('with OMNI_NO_AUTO_INSTALL, refuses a version mismatch and names both versions', () => {
    const { commands, error } = run({ installed: '0.11.9', noAutoInstall: true });
    expect(error).toBeInstanceOf(PythonDepsError);
    expect(String((error as Error).message)).toMatch(/0\.11\.9.*0\.11\.10 is pinned/);
    expect(pipCalls(commands)).toHaveLength(0);
  });

  it('with OMNI_NO_AUTO_INSTALL, does not create or repair a venv', () => {
    const missing = run({ venvExists: false, noAutoInstall: true });
    expect(missing.error).toBeInstanceOf(PythonDepsError);
    expect(missing.commands.some(c => c.includes('-m venv'))).toBe(false);

    const broken = run({ venvUsable: false, noAutoInstall: true });
    expect(broken.error).toBeInstanceOf(PythonDepsError);
    expect(broken.commands.some(c => c.includes('-m venv'))).toBe(false);
  });

  it('with the flag set and the environment as pinned, starts normally', () => {
    const { error } = run({ noAutoInstall: true });
    expect(error).toBeUndefined();
  });
});

describe('wiring', () => {
  it('server.ts no longer installs pdfplumber by bare name and exits on a PythonDepsError', () => {
    const server = read('legacy', 'apps', 'shell', 'server.ts');
    expect(server).not.toMatch(/pip install pdfplumber/);
    expect(server).toMatch(/OMNI_NO_AUTO_INSTALL/);
    expect(server).toMatch(/instanceof PythonDepsError[\s\S]{0,400}process\.exit\(1\)/);
  });

  it('CI installs Python deps from the requirements file', () => {
    const ci = read('.github', 'workflows', 'ci.yml');
    expect(ci).not.toMatch(/pip install pdfplumber/);
    expect(ci).toMatch(/pip install -r legacy\/backend\/requirements\.txt/);
  });

  it('CI runs npm audit for production dependencies as a report-only step', () => {
    const ci = read('.github', 'workflows', 'ci.yml');
    expect(ci).toMatch(/npm audit --omit=dev/);
    const step = ci.slice(ci.indexOf('npm audit --omit=dev') - 400, ci.indexOf('npm audit --omit=dev') + 200);
    expect(step).toMatch(/continue-on-error:\s*true/);
  });
});
