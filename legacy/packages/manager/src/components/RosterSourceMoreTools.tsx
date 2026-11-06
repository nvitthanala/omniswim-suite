/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "More tools" group on the Athletes step: one collapsed Disclosure that
 * holds four more Disclosures for the less common jobs. Each wraps an existing
 * panel that renders only its body, so every tool stays reachable and nothing
 * else competes with the add-athletes picker for attention.
 */

import React, { useState } from 'react';
import { ArrowLeftRight, GitCompare, History, ListChecks, Wrench } from 'lucide-react';
import type { ClassYear, Gender, ScoringSettings, Workspace } from '@omniswim/core/types';
import { countWorkingCopyChanges } from '@omniswim/core/lib/workingCopyChanges';
import { Disclosure } from '@omniswim/ui';
import LoadMeetHereCard from './LoadMeetHereCard';
import BaselineDiffPanel from './BaselineDiffPanel';
import WorkingCopyChangesPanel from './WorkingCopyChangesPanel';
import ScoringTheoryPanel from './ScoringTheoryPanel';

type Props = {
  workspace: Workspace;
  gender: Gender;
  selectedTeam: string;
  scoringSettings: ScoringSettings;
  whatIfMode: boolean;
  hasSource: boolean;
  classYearOverrides?: Record<string, ClassYear>;
  onUpdate: (patch: Partial<Workspace>) => void;
};

export default function RosterSourceMoreTools({
  workspace,
  gender,
  selectedTeam,
  scoringSettings,
  whatIfMode,
  hasSource,
  classYearOverrides,
  onUpdate,
}: Props) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const editCount = countWorkingCopyChanges(workspace, gender).total;

  return (
    <Disclosure
      icon={<Wrench size={16} />}
      title="More tools"
      summary="Copy a meet, compare, revert, import a plan"
      open={toolsOpen}
      onOpenChange={setToolsOpen}
    >
      <div className="flex flex-col gap-2">
        <Disclosure
          icon={<ArrowLeftRight size={16} />}
          title="Copy meet and scoring rules from another workspace"
        >
          <LoadMeetHereCard workspace={workspace} onUpdate={onUpdate} whatIfMode={whatIfMode} />
        </Disclosure>

        <Disclosure
          icon={<GitCompare size={16} />}
          title="Changes from the loaded meet"
          open={diffOpen}
          onOpenChange={setDiffOpen}
        >
          {hasSource ? (
            <BaselineDiffPanel
              workspace={workspace}
              gender={gender}
              team={selectedTeam}
              scoringSettings={scoringSettings}
              active={toolsOpen && diffOpen}
            />
          ) : (
            <p className="text-ui-caption text-theme-muted">
              No frozen meet baseline yet. Load a meet in Matrix first.
            </p>
          )}
        </Disclosure>

        <Disclosure
          icon={<History size={16} />}
          title="Working copy changes"
          summary={editCount > 0 ? `${editCount} ${editCount === 1 ? 'change' : 'changes'}` : undefined}
        >
          <WorkingCopyChangesPanel
            workspace={workspace}
            gender={gender}
            onUpdate={onUpdate}
            disabled={!whatIfMode}
          />
        </Disclosure>

        <Disclosure icon={<ListChecks size={16} />} title="Import a scoring plan">
          <ScoringTheoryPanel
            workspace={workspace}
            gender={gender}
            team={selectedTeam}
            classYearOverrides={classYearOverrides}
            onUpdate={onUpdate}
            applyDisabled={!whatIfMode}
          />
        </Disclosure>
      </div>
    </Disclosure>
  );
}
