/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Python virtualenv bootstrap for the PDF parsers (improvement plan S2).
 *
 * Moved out of `server.ts`, which starts its server at import time and so cannot
 * be tested. Behavior is the old `ensurePythonVenv` plus two changes:
 *
 * 1. Dependencies come from `backend/requirements.txt`, where `pdfplumber` is
 *    pinned to an exact version. The old code ran `pip install pdfplumber`, which
 *    takes whatever is newest on the day the server first starts.
 * 2. `OMNI_NO_AUTO_INSTALL=1` forbids installing at runtime. If anything would
 *    need creating, repairing or installing, this throws {@link PythonDepsError}
 *    and the server exits with the message, instead of changing the machine.
 *
 * An installed `pdfplumber` whose version differs from the pin is treated as
 * missing: it is reinstalled from the file, or refused under the flag.
 */
import fs from 'node:fs';
import path from 'node:path';

export const REQUIREMENTS_RELATIVE_PATH = path.join('backend', 'requirements.txt');
const PINNED_PACKAGE = 'pdfplumber';

/** Raised for "the environment is not as pinned and I was told not to fix it". */
export class PythonDepsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonDepsError';
  }
}

/**
 * The exact version a requirements file pins for `pkg`. Throws when the file has
 * no `pkg==x.y.z` line: an unpinned requirement is the defect S2 removes.
 */
export function readPinnedVersion(requirementsText: string, pkg: string = PINNED_PACKAGE): string {
  for (const rawLine of requirementsText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9.+!_-]+)$/.exec(line);
    if (match !== null && match[1].toLowerCase() === pkg.toLowerCase()) return match[2];
  }
  throw new Error(`${REQUIREMENTS_RELATIVE_PATH} must pin ${pkg} to an exact version (${pkg}==x.y.z).`);
}

export interface EnsurePythonEnvOptions {
  readonly projectRoot: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** `OMNI_NO_AUTO_INSTALL === '1'`. */
  readonly noAutoInstall: boolean;
  /**
   * Run a shell command in `projectRoot`. Returns trimmed stdout and throws on a
   * non-zero exit. `inherit` streams the child's output (used for `pip install`).
   */
  readonly exec: (command: string, mode?: { readonly inherit?: boolean }) => string;
  /** Test seam. Defaults to `node:fs`. */
  readonly fs?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'rmSync'>;
}

function venvPythonPath(venvPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.join(venvPath, 'Scripts', 'python.exe') : path.join(venvPath, 'bin', 'python');
}

/**
 * Make sure `<projectRoot>/venv` exists with the pinned `pdfplumber`.
 * Returns the venv's Python path. Throws {@link PythonDepsError} when something
 * needs installing and `noAutoInstall` is set.
 */
export function ensurePythonEnv(options: EnsurePythonEnvOptions): string {
  const { projectRoot, platform, noAutoInstall, exec } = options;
  const fsApi = options.fs ?? fs;
  const venvPath = path.join(projectRoot, 'venv');
  const requirementsPath = path.join(projectRoot, REQUIREMENTS_RELATIVE_PATH);
  const pinned = readPinnedVersion(fsApi.readFileSync(requirementsPath, 'utf8') as string);
  const pythonCmd = platform === 'win32' ? 'python' : 'python3';
  const installCommand = (py: string) => `"${py}" -m pip install -r "${REQUIREMENTS_RELATIVE_PATH}"`;
  const refuse = (what: string): never => {
    throw new PythonDepsError(
      `${what} OMNI_NO_AUTO_INSTALL=1 forbids installing at runtime. ` +
        `Run: ${pythonCmd} -m venv venv && ${installCommand(venvPythonPath('venv', platform))}`
    );
  };

  const createVenv = () => exec(`${pythonCmd} -m venv venv`);
  const usable = (py: string): boolean => {
    try {
      exec(`"${py}" -c "import sys"`);
      return true;
    } catch {
      return false;
    }
  };

  let venvPython = venvPythonPath(venvPath, platform);
  if (!fsApi.existsSync(venvPath)) {
    if (noAutoInstall) refuse('The Python virtualenv at venv/ does not exist.');
    createVenv();
  }
  if (!usable(venvPython)) {
    if (noAutoInstall) refuse('The Python virtualenv at venv/ is not usable.');
    fsApi.rmSync(venvPath, { recursive: true, force: true });
    createVenv();
    venvPython = venvPythonPath(venvPath, platform);
    if (!usable(venvPython)) throw new Error('Python venv could not be created or repaired');
  }

  let installed: string | undefined;
  try {
    installed = exec(
      `"${venvPython}" -c "import importlib.metadata as m; print(m.version('${PINNED_PACKAGE}'))"`
    ).trim();
  } catch {
    installed = undefined;
  }
  if (installed === pinned) return venvPython;

  if (noAutoInstall) {
    refuse(
      installed === undefined
        ? `${PINNED_PACKAGE} is not installed in venv/ (pinned: ${pinned}).`
        : `${PINNED_PACKAGE} ${installed} is installed in venv/ but ${pinned} is pinned.`
    );
  }
  exec(installCommand(venvPython), { inherit: true });
  return venvPython;
}
