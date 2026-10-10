/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Roster management wizard — Athletes → Lineup → Relays → Optimize.
 */

import React from 'react';
import { ClipboardPaste, LayoutList, Sparkles, Waves } from 'lucide-react';
import { WizardShell, type WizardStep } from '@omniswim/ui';

export type RosterWizardStepId = 'source' | 'lineup' | 'relays' | 'optimize';

const STEPS: WizardStep<RosterWizardStepId>[] = [
  { id: 'source', label: 'Athletes', title: 'Add athletes', hint: 'Add athletes and swims, and check the meet and scoring rules this roster uses.', icon: <ClipboardPaste size={16} /> },
  { id: 'lineup', label: 'Lineup', title: 'Build the roster', hint: 'Pick scorers, plan entries, and clear checklist warnings.', icon: <LayoutList size={16} /> },
  { id: 'relays', label: 'Relays', title: 'Fill relay legs', hint: 'Replace vacant legs and build relays from the individual lineup.', icon: <Waves size={16} /> },
  { id: 'optimize', label: 'Optimize', title: 'Find more points', hint: 'Review trade-offs and apply the strongest lineup.', icon: <Sparkles size={16} /> },
];

type Props = {
  step: RosterWizardStepId;
  onStepChange: (step: RosterWizardStepId) => void;
  toolbar?: React.ReactNode;
  /** The shared team bar, shown under the step tabs on every step. */
  subheader?: React.ReactNode;
  children: React.ReactNode;
};

export default function RosterWizardShell(props: Props) {
  return <WizardShell steps={STEPS} eyebrow="Roster workflow" ariaLabel="Roster steps" {...props} />;
}
