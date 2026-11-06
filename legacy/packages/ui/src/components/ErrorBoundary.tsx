/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Catches a render error below it and shows a plain message instead of a blank
 * app. The shell puts one around the whole layout, one per route and one around
 * each applet, so a fault in Matrix leaves Manager, the header and the sidebar
 * alone.
 *
 * Two ways out are offered:
 *   - Reload. First click re-renders the area from a clean state. If the same
 *     area fails again, or the error is a failed code-chunk download (which a
 *     re-render cannot fix, because `React.lazy` caches the rejected import),
 *     it reloads the page.
 *   - Restore last backup. Only shown when the host passes `backup`. This
 *     package does not know the server, so the host supplies the two calls.
 *     A call may reject with `{ status: 403, code: 'ADMIN_REQUIRED' }`; the
 *     fallback then says that an administrator must do it and keeps Reload.
 *
 * The error and its component stack go to the console under the prefix
 * `[ErrorBoundary]`.
 */
import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw, History } from 'lucide-react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

export interface BackupChoice {
  /** Bare file name. The only thing passed back to `restore`. */
  file: string;
  /** ISO instant the backup was written, when known. */
  writtenAt: string | null;
  /** Why the backup was taken (startup, manual, pre-delete). */
  label: string | null;
}

export interface BackupRestoreActions {
  /** Newest backup, or null when there is none. */
  findLast: () => Promise<BackupChoice | null>;
  /** Replace the workspaces with this backup. */
  restore: (file: string) => Promise<void>;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Plain name of the part that failed, such as "Matrix". Shown in the heading. */
  area?: string;
  /** Restore calls. Omit to hide the "Restore last backup" button. */
  backup?: BackupRestoreActions;
  /** Reloads the whole page. Defaults to `window.location.reload()`. */
  onPageReload?: () => void;
}

interface BoundaryState {
  error: Error | null;
  retried: boolean;
}

const CHUNK_LOAD_PATTERN =
  /dynamically imported module|importing a module script failed|loading chunk|loading css chunk|ChunkLoadError/i;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isChunkLoadError(error: Error): boolean {
  return CHUNK_LOAD_PATTERN.test(`${error.name} ${error.message}`);
}

function defaultPageReload(): void {
  window.location.reload();
}

function isAdminRequired(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, status } = err as { code?: unknown; status?: unknown };
  return code === 'ADMIN_REQUIRED' || status === 403;
}

function describeRestoreFailure(err: unknown): string {
  if (isAdminRequired(err)) {
    return 'Only an administrator can restore a backup on this server. Ask an administrator, or use Reload.';
  }
  const detail = err instanceof Error && err.message ? ` ${err.message}` : '';
  return `The backup could not be restored.${detail}`;
}

function describeBackup(choice: BackupChoice): string {
  const when = choice.writtenAt ? new Date(choice.writtenAt) : null;
  const stamp = when && !Number.isNaN(when.getTime()) ? ` from ${when.toLocaleString()}` : '';
  return `${choice.file}${stamp}`;
}

interface FallbackProps {
  area?: string;
  error: Error;
  retried: boolean;
  backup?: BackupRestoreActions;
  onReset: () => void;
  onPageReload: () => void;
}

function ErrorFallback({ area, error, retried, backup, onReset, onPageReload }: FallbackProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const needsPageReload = retried || isChunkLoadError(error);

  const handleRestore = async () => {
    if (!backup) return;
    setBusy(true);
    setMessage(null);
    try {
      const last = await backup.findLast();
      if (!last) {
        setMessage('No backup was found on this server. Use Reload.');
        return;
      }
      const confirmed = window.confirm(
        `Restore ${describeBackup(last)}? This replaces every workspace with the contents of that backup. The app saves a copy of the current data first.`
      );
      if (!confirmed) return;
      await backup.restore(last.file);
      onPageReload();
    } catch (err) {
      setMessage(describeRestoreFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const where = area ? ` in ${area}` : '';
  return (
    <EmptyState
      className="m-4"
      icon={<AlertTriangle size={24} aria-hidden />}
      title={`Something went wrong${where}`}
      description={
        backup
          ? 'This screen hit an error and stopped. Use Reload to try again. If it keeps happening, restore your most recent backup.'
          : 'This screen hit an error and stopped. Use Reload to try again.'
      }
      secondaryAction={
        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              onClick={needsPageReload ? onPageReload : onReset}
              leadingIcon={<RotateCcw size={16} aria-hidden />}
            >
              Reload
            </Button>
            {backup ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void handleRestore()}
                leadingIcon={<History size={16} aria-hidden />}
              >
                {busy ? 'Restoring…' : 'Restore last backup'}
              </Button>
            ) : null}
          </div>
          {message ? (
            <p
              role="alert"
              className="max-w-xl rounded-lg border border-[var(--toast-border)] bg-[var(--toast-bg)] p-3 text-ui-caption text-[var(--toast-text)]"
            >
              {message}
            </p>
          ) : null}
        </div>
      }
    />
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, retried: false };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const label = this.props.area ? ` ${this.props.area}` : '';
    console.error(`[ErrorBoundary]${label} render error`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null, retried: true });
  };

  render(): ReactNode {
    const { error, retried } = this.state;
    if (!error) return this.props.children;
    return (
      <ErrorFallback
        area={this.props.area}
        error={error}
        retried={retried}
        backup={this.props.backup}
        onReset={this.reset}
        onPageReload={this.props.onPageReload ?? defaultPageReload}
      />
    );
  }
}
