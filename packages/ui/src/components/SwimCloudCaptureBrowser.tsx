/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One capture-browsing surface, used by every applet that needs one.
 *
 * Replaces two independently-grown components that did the same job for two
 * different consumers — `packages/matrix/src/components/SwimCloudCapturePicker.tsx`
 * (769 lines) and `packages/manager/src/components/SwimCloudCaptureRosterImportPanel.tsx`
 * (476 lines). Both fetched the pairing token, listed captures, parsed one,
 * rendered honest completeness, and offered a "forget this capture" action.
 * Only what they DID with a parsed capture ever differed, and that difference
 * is real: Matrix converts meet results into `SwimmerResult[]`; Manager
 * converts a roster plus its swimmer-times pages into `HistoricalSwim[]`.
 * See `plans/2026-09-09/01-UI-REDESIGN-PLAN.md` §3.
 *
 * So this component browses. It never converts. Each consumer passes one
 * callback that receives exactly what it selected, and owns its own toasts,
 * its own workspace writes, and its own decision to close the window.
 *
 * ## Server contract this builds against
 *
 * ```
 * GET    /api/swimcloud/pairing-token   -> 200, { token }
 * GET    /api/swimcloud/captures        -> 200, SwimCloudCaptureRecord[]
 * POST   /api/swimcloud/captures/:id/parse
 *          -> 200, { captureId, subject, parses, rosters, swimmerTimes,
 *                    eventResults, warnings }
 *          -> 404 if the capture id doesn't exist
 * DELETE /api/swimcloud/captures/:id    -> 200, { success, captureId, pagesDeleted }
 * ```
 *
 * `apps/shell/lib/swimcloudCaptureRoutes.ts` gates every capture route behind
 * a pairing-token header (`X-Omniswim-Capture-Token`). The token is fetched
 * once from `GET /api/swimcloud/pairing-token`, which is gated by this app's
 * own auth. If that fetch fails — capture routes not registered on a
 * non-loopback bind, or this app's auth rejecting it — the browser says why
 * and never calls a capture route it knows will 401.
 *
 * ## Progressive disclosure
 *
 * One always-visible picker plus one honest status line. Below it, three
 * collapsible sections — rosters, swimmer times, meet results — of which the
 * `mode`-relevant one starts expanded and carries the action button. The
 * other two collapse until a coach asks for them, and are omitted entirely
 * when the capture holds nothing of that kind. `mode` chooses which section
 * leads; it never changes which network calls happen.
 *
 * ## Honest completeness — no bare "Complete"
 *
 * `SwimCloudCaptureCompleteness` deliberately has no `'complete'` value (see
 * that type's own doc comment in `packages/swimcloud/src/captureStore.ts`):
 * `'every-planned-page-fetched'` is a claim about the crawl plan, not a claim
 * that SwimCloud's own team list was ever verified. {@link describeCompleteness}
 * always folds `teamDiscovery.completeness` into the sentence instead of
 * collapsing either value to "Complete." The word is not rendered anywhere in
 * this file, not even as a column heading.
 *
 * ## Motion
 *
 * None is added. Sections show and hide instantly, so there is no transition
 * for `prefers-reduced-motion` to reduce. The only `transition-*` classes here
 * are the repo's existing hover colour transitions, which carry no movement.
 */

import { useEffect, useRef } from 'react';
import { FloatingWindow } from './FloatingWindow';
import { useToast } from './Toast';
import { CaptureListPicker, CaptureStatusPanel, NoCapturesEmptyState, CaptureErrorBanner } from './SwimCloudCaptureBrowserChrome';
import { SwimCloudCaptureRosterSection } from './SwimCloudCaptureRosterSection';
import { SwimCloudCaptureSwimmerTimesSection } from './SwimCloudCaptureSwimmerTimesSection';
import { SwimCloudCaptureMeetResultsSection } from './SwimCloudCaptureMeetResultsSection';
import {
  captureDisplayLabel,
  capturePagesPhrase,
  describeCaptureScope,
  describeCompleteness,
  subjectLabel,
  type SwimCloudCaptureBrowserProps,
} from './swimCloudCaptureBrowserView';
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, useSwimCloudCaptureWindow } from './useSwimCloudCaptureWindow';
import { useSwimCloudCaptureList } from './useSwimCloudCaptureList';
import { useSwimCloudCaptureSelection } from './useSwimCloudCaptureSelection';
import { useSwimCloudCaptureImport } from './useSwimCloudCaptureImport';

// The shapes, props and honest-text helpers live in
// `swimCloudCaptureBrowserView.ts`. They are re-exported here so every existing
// import path (`./SwimCloudCaptureBrowser`, `@omniswim/ui`) keeps working.
export {
  subjectLabel,
  captureDisplayLabel,
  capturePagesPhrase,
  describeCompleteness,
  capturePassStatus,
  describeCaptureScope,
  describeUnplannedPass,
  describeRosterCoverage,
  groupParses,
  rosterKeyFor,
  rosterTeamLabel,
  rosterHeading,
  swimmerTimesLabel,
} from './swimCloudCaptureBrowserView';
export type {
  SwimCloudCaptureCompleteness,
  SwimCloudCaptureTeamDiscovery,
  SwimCloudCapturePageRef,
  SwimCloudCaptureRecord,
  SwimCloudCaptureParseResponse,
  SwimCloudCaptureRosterCoverage,
  SwimCloudCaptureParseGroup,
  SwimCloudCapturePassStatus,
  SwimCloudCaptureBrowserMode,
  SwimCloudCapturePasteFallback,
  SwimCloudCaptureMeetResultsSelection,
  SwimCloudCaptureRosterSelection,
  SwimCloudCaptureMeetResultsProps,
  SwimCloudCaptureRosterHistoryProps,
  SwimCloudCaptureBrowserProps,
} from './swimCloudCaptureBrowserView';

/** The window title and the one-line description under it; both default per mode. */
function windowCopy(props: SwimCloudCaptureBrowserProps): { windowTitle: string; description: string } {
  const { mode } = props;
  const windowTitle =
    props.title ??
    (mode === 'meet-results'
      ? 'SwimCloud captures — meet results'
      : 'SwimCloud captures — roster history');
  const description =
    props.description ??
    (mode === 'meet-results'
      ? 'Pick a capture the extension has fetched, then choose which teams and genders to load.'
      : `Pick a capture, then a roster in it. Every swimmer it captured times for is imported at once, into ${
          props.mode === 'roster-history' && props.team.trim() ? props.team.trim() : 'the selected team'
        } · ${props.mode === 'roster-history' ? props.genderLabel : ''}`.trim());
  return { windowTitle, description };
}

/* ========================================================================== */
/* The browser                                                                */
/* ========================================================================== */

export function SwimCloudCaptureBrowser(props: SwimCloudCaptureBrowserProps) {
  const { mode, onClose, pasteFallback } = props;
  const toast = useToast();

  const { windowTitle, description } = windowCopy(props);
  const storageKey = props.storageKey ?? `omni-swimcloud-capture-browser-${mode}`;

  const mountedRef = useRef(true);
  const pickerRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const { windowState, setWindowState } = useSwimCloudCaptureWindow(storageKey, onClose);
  const list = useSwimCloudCaptureList();
  const { captures, listError, tokenError, refresh, retryToken, hasCaptureRows, isLoadingList } = list;

  useEffect(() => {
    pickerRef.current?.focus();
  }, []);

  const selection = useSwimCloudCaptureSelection(props, list, mountedRef, toast);
  const { selectedCapture, parseResponse } = selection;
  const { isImporting, importMeetResults, importRoster } = useSwimCloudCaptureImport(
    props,
    selection,
    mountedRef,
    toast
  );

  const rosterScope =
    props.mode === 'roster-history' ? { team: props.team, genderLabel: props.genderLabel } : null;

  return (
    <FloatingWindow
      title={windowTitle}
      open
      onClose={onClose}
      state={windowState}
      onStateChange={setWindowState}
      minWidth={MIN_WINDOW_WIDTH}
      minHeight={MIN_WINDOW_HEIGHT}
    >
      <div className="h-full overflow-y-auto custom-scrollbar p-4 space-y-3">
        <p className="text-ui-caption text-theme-muted">{description}</p>

        <CaptureErrorBanner tokenError={tokenError} listError={listError} onRetryToken={() => void retryToken()} />

        {tokenError === null ? (
          <CaptureListPicker
            pickerRef={pickerRef}
            captureOptions={
              captures?.map(capture => {
                const label = captureDisplayLabel(capture);
                const subject = subjectLabel(capture.subject);
                return {
                  captureId: capture.captureId,
                  label: `${label === subject ? label : `${label} · ${subject}`} · ${capturePagesPhrase(capture)}`,
                };
              }) ?? null
            }
            selectedCaptureId={selection.selectedCaptureId}
            hasCaptureRows={hasCaptureRows}
            isLoadingList={isLoadingList}
            isParsing={selection.isParsing}
            onSelectChange={captureId => {
              if (captureId === '') {
                selection.clearSelection();
                return;
              }
              void selection.selectCapture(captureId);
            }}
            onRefresh={() => void refresh()}
            selectedCaptureLabel={selectedCapture !== null ? captureDisplayLabel(selectedCapture) : null}
            confirmingForget={selection.confirmingForget}
            onRequestForget={() => selection.setConfirmingForget(true)}
            onConfirmForget={() => void selection.forgetSelectedCapture()}
            onCancelForget={() => selection.setConfirmingForget(false)}
          />
        ) : null}

        {selectedCapture !== null ? (
          <CaptureStatusPanel
            isParsing={selection.isParsing}
            completenessText={describeCompleteness(selectedCapture)}
            scopeText={describeCaptureScope(selectedCapture)}
            isPartial={selectedCapture.completeness === 'partial'}
            notes={selectedCapture.notes}
          />
        ) : null}

        {tokenError === null && isLoadingList ? (
          <p className="text-ui-body text-theme-muted">Loading captures…</p>
        ) : null}

        {!isLoadingList && !hasCaptureRows ? <NoCapturesEmptyState pasteFallback={pasteFallback} /> : null}

        {parseResponse !== null ? (
          <div className="space-y-2 border-t border-theme-soft pt-3">
            <SwimCloudCaptureRosterSection
              parseResponse={parseResponse}
              selectedCapture={selectedCapture}
              rosterScope={rosterScope}
              expanded={selection.expandedSections.rosters}
              onToggle={() => selection.toggleSection('rosters')}
              rosterOptions={selection.rosterOptions}
              selectedRosterKey={selection.selectedRosterKey}
              selectedRoster={selection.selectedRoster}
              onSelectRoster={selection.setSelectedRosterKey}
              expandedRosterKeys={selection.expandedRosterKeys}
              onToggleRosterExpanded={selection.toggleRosterExpanded}
              isImporting={isImporting}
              onImportRoster={() => void importRoster()}
            />
            <SwimCloudCaptureSwimmerTimesSection
              parseResponse={parseResponse}
              selectedCapture={selectedCapture}
              expanded={selection.expandedSections.swimmerTimes}
              onToggle={() => selection.toggleSection('swimmerTimes')}
              expandedSwimmerKeys={selection.expandedSwimmerKeys}
              onToggleSwimmerExpanded={selection.toggleSwimmerExpanded}
            />
            <SwimCloudCaptureMeetResultsSection
              parseResponse={parseResponse}
              selectedCapture={selectedCapture}
              isLead={mode === 'meet-results'}
              expanded={selection.expandedSections.meetResults}
              onToggle={() => selection.toggleSection('meetResults')}
              groups={selection.groups}
              checkedGroups={selection.checkedGroups}
              onToggleGroup={selection.toggleGroup}
              isImporting={isImporting}
              onImportMeetResults={() => void importMeetResults()}
            />
          </div>
        ) : null}
      </div>
    </FloatingWindow>
  );
}
