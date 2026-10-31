import { createContext, useContext, type ReactNode } from 'react';

/**
 * Lets a deep component (the Matrix Meet step, the workspace sidebar) open the
 * "Build theoretical meet" dialog without owning it. The shell provides the
 * opener and mounts the dialog, because Matrix and Manager are sibling packages
 * and must not import each other.
 *
 * Unlike `useOpenScoringRules`, the hook returns `null` with no provider, so a
 * host that cannot build a theoretical meet shows no button at all instead of a
 * button that does nothing.
 */
const TheoreticalMeetOpenerContext = createContext<(() => void) | null>(null);

export function TheoreticalMeetOpenerProvider({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  return <TheoreticalMeetOpenerContext.Provider value={onOpen}>{children}</TheoreticalMeetOpenerContext.Provider>;
}

export function useOpenTheoreticalMeet(): (() => void) | null {
  return useContext(TheoreticalMeetOpenerContext);
}
