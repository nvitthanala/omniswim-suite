import { AnimatePresence, motion } from 'motion/react';
import { Gender, type Workspace } from '@omniswim/core/types';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import OpsModule from './components/OpsModule';

export default function MatrixApp() {
  const { activeWorkspace, activeGender, updateWorkspace } = useSuiteWorkspace();

  if (!activeWorkspace) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-theme-secondary">
        <p className="text-xs uppercase tracking-widest font-bold">Select or create a workspace to use Matrix</p>
      </div>
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
