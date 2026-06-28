/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export type WorkspaceTabId = 'meet-ops' | 'team-mgmt';

type Props = {
  activeTab: WorkspaceTabId;
  onTabChange: (tab: WorkspaceTabId) => void;
  className?: string;
};

const TABS: { id: WorkspaceTabId; label: string }[] = [
  { id: 'meet-ops', label: 'Meet Charts/Tables' },
  { id: 'team-mgmt', label: 'Team Management' },
];

export default function WorkspaceTabs({ activeTab, onTabChange, className }: Props) {
  return (
    <nav
      className={`flex gap-1 p-1 surface-overlay border border-theme-soft rounded-lg w-fit${className ? ` ${className}` : ''}`}
      aria-label="Workspace views"
    >
      {TABS.map(tab => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onTabChange(tab.id)}
          className={`px-4 py-2 text-ui-label font-bold uppercase tracking-widest rounded-md transition-all ${
            activeTab === tab.id ? 'nav-tab-active' : 'nav-tab-inactive'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
