import { AnimatePresence, motion } from 'motion/react';
import { BarChart3 } from 'lucide-react';
import { Gender, type Workspace } from '@omniswim/core/types';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { EmptyState } from '@omniswim/ui';
import OpsModule from './components/OpsModule';

export default function MatrixApp() {
  const { activeWorkspace, activeGender, updateWorkspace } = useSuiteWorkspace();

  if (!activeWorkspace) {
    return (
      <EmptyState
        icon={<BarChart3 size={28} />}
        eyebrow="Matrix"
        title="Start with a workspace, then load meet results"
        description="Matrix uses a workspace to hold HyTek PDFs, scoring settings, team totals, and what-if roster changes."
      />
    );
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={`${activeWorkspace.id}-${activeGender}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      >
        <OpsModule
          workspace={activeWorkspace}
          gender={activeGender}
          onUpdate={updateWorkspace}
        />
      </motion.div>
    </AnimatePresence>
  );
}
