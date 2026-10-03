import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

const ScoringRulesOpenerContext = createContext<(() => void) | null>(null);

export function ScoringRulesOpenerProvider({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  const openScoringRules = useCallback(() => onOpen(), [onOpen]);
  const value = useMemo(() => openScoringRules, [openScoringRules]);
  return <ScoringRulesOpenerContext.Provider value={value}>{children}</ScoringRulesOpenerContext.Provider>;
}

export function useOpenScoringRules(): () => void {
  const open = useContext(ScoringRulesOpenerContext);
  return open ?? (() => {});
}
