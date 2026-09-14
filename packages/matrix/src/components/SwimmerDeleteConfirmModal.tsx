/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ConfirmDeleteModal } from '@omniswim/ui';
import { Gender } from '@omniswim/core/types';

interface Props {
  swimmerName: string;
  gender: Gender;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function SwimmerDeleteConfirmModal({ swimmerName, gender, onConfirm, onCancel }: Props) {
  return (
    <ConfirmDeleteModal
      title="Remove swimmer"
      description={
        <>
          Remove <span className="text-[var(--text-primary)] font-mono">{swimmerName}</span> from{' '}
          <span className="text-[var(--text-primary)]">{gender}</span> results?
        </>
      }
      warning="All individual swims for this athlete will be removed from the workspace. Relay legs will be treated as departed for projection (replacements from recruits or roster). Any recruit row with the same name will also be removed."
      confirmLabel="Confirm remove"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
