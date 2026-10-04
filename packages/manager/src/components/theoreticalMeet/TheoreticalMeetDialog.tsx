/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Build theoretical meet": pick crawled teams, choose scoring, preview, create a NEW workspace.
 *
 * Three steps in one dialog (Teams, Scoring, Preview). The data layer does all the work
 * (`theoreticalMeetFlow.ts`); this file is the frame, the stepper and the footer.
 *
 * - `TheoreticalMeetDialog` reads the workspace provider. The shell mounts it.
 * - `TheoreticalMeetDialogContent` takes everything as props, so a test can drive it with a fake
 *   capture API and a fake `restoreWorkspace`.
 *
 * Motion (emil-design-eng, apple-design): the dialog is opened occasionally, so it fades and scales
 * from 0.98 in 150 ms, ease-out, centred (a modal has no trigger to grow from). A step change is a
 * 120 ms opacity cross-fade, no movement. Reduced motion drops the scale and keeps the fade. Keyboard
 * actions inside the dialog do not animate.
 *
 * Layout: the card has a fixed height and the body scrolls, so a step change or a loading row never
 * moves the header or the footer.
 */

import { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { Button, Modal } from '@omniswim/ui';
import type { Workspace } from '@omniswim/core/types';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { createCaptureApi, type CaptureApi } from './captureApi';
import { PreviewStep } from './PreviewStep';
import { ScoringStep } from './ScoringStep';
import { TeamsStep } from './TeamsStep';
import { useTheoreticalMeetFlow, type FlowStep } from './useTheoreticalMeetFlow';
import { createBlockers, type CaptureRow } from './theoreticalMeetView';

const STEPS: readonly { readonly id: FlowStep; readonly label: string }[] = [
  { id: 'teams', label: 'Teams' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'preview', label: 'Preview' },
];

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

function Stepper({ step }: { step: FlowStep }) {
  const current = STEPS.findIndex(s => s.id === step);
  return (
    <ol className="flex items-center gap-2 text-ui-caption" aria-label="Steps">
      {STEPS.map((s, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={s.id} aria-current={active ? 'step' : undefined} className="flex items-center gap-2">
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border text-ui-micro ${
                active
                  ? 'border-[var(--text-accent)] bg-[var(--text-accent)]/15 text-[var(--text-accent)]'
                  : done
                    ? 'border-[var(--text-accent)]/40 text-[var(--text-accent)]'
                    : 'border-theme-soft text-theme-muted'
              }`}
              aria-hidden="true"
            >
              {done ? <Check size={11} /> : index + 1}
            </span>
            <span className={active ? 'font-medium text-[var(--text-primary)]' : 'text-theme-secondary'}>
              {s.label}
              <span className="sr-only">{done ? ' (done)' : active ? ' (current step)' : ''}</span>
            </span>
            {index < STEPS.length - 1 ? <span className="mx-1 h-px w-6 border-t border-theme-soft" aria-hidden="true" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export interface TheoreticalMeetDialogContentProps {
  readonly api: CaptureApi;
  readonly workspaces: readonly Workspace[];
  readonly restoreWorkspace: (workspace: Workspace) => Promise<Workspace>;
  readonly onClose: () => void;
  /** Called with the saved workspace after Create succeeds. The host closes the dialog and navigates. */
  readonly onCreated: (workspace: Workspace) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export function TheoreticalMeetDialogContent(props: TheoreticalMeetDialogContentProps) {
  const { api, workspaces, restoreWorkspace, onClose, onCreated, now, newId } = props;
  const flow = useTheoreticalMeetFlow({ api, workspaces, restoreWorkspace, onCreated, now, newId });
  const reducedMotion = useReducedMotion();
  const { step, setStep, selected, scoringChoiceId, preview, creating, groups, anyFailed, createProblem } = flow;

  const captureRows = useMemo(() => {
    const map = new Map<string, CaptureRow>();
    for (const group of groups) for (const row of group.rows) map.set(row.captureId, row);
    return map;
  }, [groups]);

  const problem = preview.status === 'error' ? preview.problem : null;
  const blockers = createBlockers({
    selectedCount: selected.length,
    scoringChoiceId,
    problem,
    previewReady: preview.status === 'ready',
    creating,
  });
  const createBlockedBy = anyFailed ? ['A team could not be read. Retry it, or go back and unpick it.', ...blockers] : blockers;

  const guardedClose = () => {
    if (!creating) onClose();
  };

  const nextDisabled = step === 'teams' ? selected.length === 0 : step === 'scoring' ? scoringChoiceId === null : false;
  const footerMessage =
    step === 'teams'
      ? selected.length === 0
        ? 'Pick at least one team.'
        : `${selected.length} ${selected.length === 1 ? 'team' : 'teams'} picked.`
      : step === 'scoring'
        ? scoringChoiceId === null
          ? 'Pick the scoring rules.'
          : ''
        : createProblem?.message ?? createBlockedBy[0] ?? 'The new workspace is separate from your others. Nothing is overwritten.';

  return (
    <Modal
      onClose={guardedClose}
      ariaLabel="Build theoretical meet"
      className="flex h-[min(44rem,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl p-0"
      style={{ boxShadow: 'var(--ui-shadow-lg)' }}
    >
      <motion.div
        className="flex min-h-0 flex-1 flex-col"
        initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15, ease: EASE_OUT }}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-theme-soft px-5 py-4">
          <div className="space-y-3">
            <div>
              <h2 className="text-lg font-medium text-[var(--text-primary)]">Build theoretical meet</h2>
              <p className="text-ui-caption text-theme-secondary">Project a meet from crawled teams. No meet PDF is needed.</p>
            </div>
            <Stepper step={step} />
          </div>
          <Button variant="ghost" size="sm" onClick={guardedClose} aria-label="Close" disabled={creating} className="p-1.5" leadingIcon={<X size={16} />} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 custom-scrollbar">
          <motion.div key={step} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }}>
            {step === 'teams' ? <TeamsStep flow={flow} /> : null}
            {step === 'scoring' ? <ScoringStep flow={flow} /> : null}
            {step === 'preview' ? <PreviewStep flow={flow} captureRows={captureRows} /> : null}
          </motion.div>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-theme-soft px-5 py-3">
          <p className="min-h-[2.25rem] flex-1 text-ui-caption text-theme-secondary" aria-live="polite">
            {footerMessage}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={guardedClose} disabled={creating}>
              Cancel
            </Button>
            {step !== 'teams' ? (
              <Button variant="outline" onClick={() => setStep(step === 'preview' ? 'scoring' : 'teams')} disabled={creating}>
                Back
              </Button>
            ) : null}
            {step === 'preview' ? (
              <Button onClick={() => void flow.create()} disabled={createBlockedBy.length > 0 || preview.status !== 'ready'}>
                {creating ? 'Creating...' : 'Create theoretical meet'}
              </Button>
            ) : (
              <Button onClick={() => setStep(step === 'teams' ? 'scoring' : 'preview')} disabled={nextDisabled}>
                Next
              </Button>
            )}
          </div>
        </footer>
      </motion.div>
    </Modal>
  );
}

/** The dialog the shell mounts: reads the workspace provider and the real capture routes. */
export function TheoreticalMeetDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const { workspaces, restoreWorkspace } = useSuiteWorkspace();
  const api = useMemo(() => createCaptureApi(), []);
  return (
    <TheoreticalMeetDialogContent
      api={api}
      workspaces={workspaces}
      restoreWorkspace={restoreWorkspace}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}
