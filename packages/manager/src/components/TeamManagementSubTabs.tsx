/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export type TeamManagementViewId = 'roster' | 'ind-relay';

type Props = {
  activeView: TeamManagementViewId;
  onViewChange: (view: TeamManagementViewId) => void;
};

const VIEWS: { id: TeamManagementViewId; label: string }[] = [
  { id: 'roster', label: 'Roster' },
  { id: 'ind-relay', label: 'Ind / Relay' },
];

export default function TeamManagementSubTabs({ activeView, onViewChange }: Props) {
  return (
    <nav
      className="flex gap-1 p-1 surface-overlay border border-theme-soft rounded-xl w-fit"
      aria-label="Team management views"
    >
      {VIEWS.map(view => (
        <button
          key={view.id}
          type="button"
          onClick={() => onViewChange(view.id)}
          className={`px-3.5 py-2 text-ui-label font-semibold rounded-lg transition-all whitespace-nowrap ${
            activeView === view.id ? 'nav-tab-active' : 'nav-tab-inactive'
          }`}
        >
          {view.label}
        </button>
      ))}
    </nav>
  );
}
