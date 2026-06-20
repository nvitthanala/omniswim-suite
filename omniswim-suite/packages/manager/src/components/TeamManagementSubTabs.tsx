/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { SegmentedControl } from '@omniswim/ui';

export type TeamManagementViewId = 'roster' | 'ind-relay';

type Props = {
  activeView: TeamManagementViewId;
  onViewChange: (view: TeamManagementViewId) => void;
};

export default function TeamManagementSubTabs({ activeView, onViewChange }: Props) {
  return (
    <SegmentedControl
      options={[
        { id: 'roster' as const, label: 'Roster' },
        { id: 'ind-relay' as const, label: 'Ind / Relay' },
      ]}
      value={activeView}
      onChange={onViewChange}
    />
  );
}
