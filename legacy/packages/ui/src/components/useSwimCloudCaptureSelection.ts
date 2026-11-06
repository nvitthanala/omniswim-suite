/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s selection state: which capture is chosen, its
 * parse response, the checked groups, the chosen roster, and which read-only
 * sections and rows are expanded. Pure extraction from
 * `SwimCloudCaptureBrowser.tsx` — no behaviour change.
 */

import { useMemo, useState, type MutableRefObject } from 'react';
import type { useToast } from './Toast';
import {
  defaultExpandedFor,
  describeUnplannedPass,
  groupParses,
  rosterKeyFor,
  type SectionId,
  type SwimCloudCaptureBrowserProps,
  type SwimCloudCaptureParseResponse,
  type SwimCloudCaptureRecord,
  type SwimCloudCaptureRosterCoverage,
} from './swimCloudCaptureBrowserView';
import { CAPTURES_ENDPOINT, captureAuthHeaders, type SwimCloudCaptureList } from './useSwimCloudCaptureList';

type Toaster = ReturnType<typeof useToast>;

/** One roster in the parse response, paired with what a coach needs before choosing it. */
export interface SwimCloudCaptureRosterOption {
  readonly key: string;
  readonly roster: SwimCloudCaptureParseResponse['rosters'][number];
  readonly coverage: SwimCloudCaptureRosterCoverage | null;
  readonly genderMismatch: boolean;
}

/** Roster rows for the current parse response; coverage and the gender check apply in roster-history mode only. */
function useRosterOptions(
  props: SwimCloudCaptureBrowserProps,
  parseResponse: SwimCloudCaptureParseResponse | null
): SwimCloudCaptureRosterOption[] {
  return useMemo(() => {
    if (!parseResponse) return [];
    if (props.mode !== 'roster-history') {
      return parseResponse.rosters.map((roster, index) => ({
        key: rosterKeyFor(roster, index),
        roster,
        coverage: null as SwimCloudCaptureRosterCoverage | null,
        genderMismatch: false,
      }));
    }
    const { rosterCoverage, genderLabel } = props;
    return parseResponse.rosters.map((roster, index) => ({
      key: rosterKeyFor(roster, index),
      roster,
      coverage: rosterCoverage(roster, parseResponse.swimmerTimes),
      genderMismatch: roster.gender !== undefined && (roster.gender as string) !== genderLabel,
    }));
    // `props` is narrowed above; the mode-specific fields are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `props` is narrowed by mode; the mode-specific fields are the real deps
  }, [parseResponse, props.mode, props.mode === 'roster-history' ? props.rosterCoverage : null, props.mode === 'roster-history' ? props.genderLabel : null]);
}

/**
 * Says, once a parse lands, when the capture holds nothing the mode needs —
 * and why, when the capture's recorded scope explains it.
 */
function announceEmptyParse(
  data: SwimCloudCaptureParseResponse,
  justSelected: SwimCloudCaptureRecord | null,
  mode: SwimCloudCaptureBrowserProps['mode'],
  toast: Toaster
): void {
  if (mode === 'roster-history') {
    if (data.rosters.length === 0) {
      const why = describeUnplannedPass(justSelected, 'teamRoster');
      toast.push(
        'info',
        why === null
          ? 'This capture holds no team-roster page. Crawl the team’s roster in the extension, or capture swimmers one at a time from the clipboard.'
          : `This capture holds no team-roster page. ${why}`
      );
    }
  } else if (
    data.parses.length === 0 &&
    data.rosters.length === 0 &&
    data.swimmerTimes.length === 0
  ) {
    const why = describeUnplannedPass(justSelected, 'meetTeamSwims');
    toast.push(
      'info',
      why === null
        ? 'This capture has no parseable team-results pages yet.'
        : `This capture has no parseable team-results pages. ${why}`
    );
  }
}

/**
 * Read-only browsing state for the collapsible sections and their rows —
 * separate from `checkedGroups`/`selectedRosterKey`, which drive what actually
 * gets imported.
 */
function useSectionExpansion(mode: SwimCloudCaptureBrowserProps['mode']) {
  const [expandedSections, setExpandedSections] = useState<Record<SectionId, boolean>>(() =>
    defaultExpandedFor(mode)
  );
  const [expandedRosterKeys, setExpandedRosterKeys] = useState<Record<string, boolean>>({});
  const [expandedSwimmerKeys, setExpandedSwimmerKeys] = useState<Record<string, boolean>>({});

  const resetExpansion = () => {
    setExpandedRosterKeys({});
    setExpandedSwimmerKeys({});
    setExpandedSections(defaultExpandedFor(mode));
  };

  const toggleSection = (id: SectionId) => {
    setExpandedSections(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleRosterExpanded = (key: string) => {
    setExpandedRosterKeys(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleSwimmerExpanded = (key: string) => {
    setExpandedSwimmerKeys(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return {
    expandedSections,
    expandedRosterKeys,
    expandedSwimmerKeys,
    resetExpansion,
    toggleSection,
    toggleRosterExpanded,
    toggleSwimmerExpanded,
  };
}

export function useSwimCloudCaptureSelection(
  props: SwimCloudCaptureBrowserProps,
  list: SwimCloudCaptureList,
  mountedRef: MutableRefObject<boolean>,
  toast: Toaster
) {
  const { mode } = props;
  const { captures, pairingToken, loadCaptures } = list;

  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [parseResponse, setParseResponse] = useState<SwimCloudCaptureParseResponse | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [checkedGroups, setCheckedGroups] = useState<Record<string, boolean>>({});
  const [selectedRosterKey, setSelectedRosterKey] = useState<string | null>(null);
  const expansion = useSectionExpansion(mode);

  const selectedCapture = useMemo(
    () => captures?.find(capture => capture.captureId === selectedCaptureId) ?? null,
    [captures, selectedCaptureId]
  );

  const groups = useMemo(
    () => (parseResponse ? groupParses(parseResponse.parses) : []),
    [parseResponse]
  );

  const rosterOptions = useRosterOptions(props, parseResponse);
  const selectedRoster = rosterOptions.find(option => option.key === selectedRosterKey) ?? null;

  const selectCapture = async (captureId: string) => {
    if (!pairingToken) return;
    setSelectedCaptureId(captureId);
    setConfirmingForget(false);
    setParseResponse(null);
    setSelectedRosterKey(null);
    expansion.resetExpansion();
    setIsParsing(true);
    try {
      const res = await fetch(`${CAPTURES_ENDPOINT}/${captureId}/parse`, {
        method: 'POST',
        headers: captureAuthHeaders(pairingToken),
      });
      if (res.status === 404) {
        toast.push('error', 'That capture no longer exists. Refreshing the list.');
        setSelectedCaptureId(null);
        await loadCaptures(pairingToken);
        return;
      }
      if (!res.ok) {
        toast.push('error', `Could not parse that capture (HTTP ${res.status}).`);
        setSelectedCaptureId(null);
        return;
      }
      const data = (await res.json()) as SwimCloudCaptureParseResponse;
      setParseResponse(data);
      const nextChecked: Record<string, boolean> = {};
      for (const group of groupParses(data.parses)) nextChecked[group.key] = true;
      setCheckedGroups(nextChecked);
      const onlyRoster = data.rosters.length === 1 ? data.rosters[0] : undefined;
      if (onlyRoster !== undefined) setSelectedRosterKey(rosterKeyFor(onlyRoster, 0));
      if (data.warnings.length > 0) {
        console.warn('SwimCloud capture parse: warnings', data.warnings);
        toast.push('info', `Parsed with ${data.warnings.length} warning(s) — see console.`);
      }
      // Looked up by id rather than read off `selectedCapture`: this closure
      // was created before `setSelectedCaptureId` above, so the memo still
      // points at whatever was selected previously.
      const justSelected = captures?.find(c => c.captureId === captureId) ?? null;
      announceEmptyParse(data, justSelected, mode, toast);
    } catch (err) {
      toast.push('error', `Could not parse that capture: ${String(err)}`);
      setSelectedCaptureId(null);
    } finally {
      if (mountedRef.current) setIsParsing(false);
    }
  };

  const forgetSelectedCapture = async () => {
    if (!pairingToken || !selectedCapture) return;
    const captureId = selectedCapture.captureId;
    try {
      const res = await fetch(`${CAPTURES_ENDPOINT}/${captureId}`, {
        method: 'DELETE',
        headers: captureAuthHeaders(pairingToken),
      });
      if (!res.ok && res.status !== 404) {
        toast.push('error', `Could not forget that capture (HTTP ${res.status}).`);
        return;
      }
      setConfirmingForget(false);
      setSelectedCaptureId(null);
      setParseResponse(null);
      setSelectedRosterKey(null);
      await loadCaptures(pairingToken);
      toast.push('success', 'Capture forgotten. It can be re-fetched from the extension.');
    } catch (err) {
      toast.push('error', `Could not forget that capture: ${String(err)}`);
    }
  };

  /** The picker's "no capture" option: drops the selection without touching the list. */
  const clearSelection = () => {
    setSelectedCaptureId(null);
    setParseResponse(null);
    setSelectedRosterKey(null);
  };

  const toggleGroup = (key: string) => {
    setCheckedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return {
    selectedCaptureId,
    selectedCapture,
    parseResponse,
    isParsing,
    confirmingForget,
    setConfirmingForget,
    expandedSections: expansion.expandedSections,
    checkedGroups,
    selectedRosterKey,
    setSelectedRosterKey,
    expandedRosterKeys: expansion.expandedRosterKeys,
    expandedSwimmerKeys: expansion.expandedSwimmerKeys,
    groups,
    rosterOptions,
    selectedRoster,
    selectCapture,
    forgetSelectedCapture,
    clearSelection,
    toggleSection: expansion.toggleSection,
    toggleGroup,
    toggleRosterExpanded: expansion.toggleRosterExpanded,
    toggleSwimmerExpanded: expansion.toggleSwimmerExpanded,
  };
}

export type SwimCloudCaptureSelection = ReturnType<typeof useSwimCloudCaptureSelection>;
