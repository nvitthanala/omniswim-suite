import type { ReactNode } from 'react';
import { ErrorBoundary } from '@omniswim/ui';
import { lastBackupActions } from '../lib/restoreLastBackup';

/** The shared ErrorBoundary wired to the shell's backup list and restore calls. */
export default function AppErrorBoundary({ area, children }: { area?: string; children: ReactNode }) {
  return (
    <ErrorBoundary area={area} backup={lastBackupActions}>
      {children}
    </ErrorBoundary>
  );
}
