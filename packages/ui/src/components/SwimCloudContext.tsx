import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type SwimCloudContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  openWindow: () => void;
  closeWindow: () => void;
  toggleWindow: () => void;
};

const SwimCloudContext = createContext<SwimCloudContextValue | null>(null);

export function SwimCloudProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openWindow = useCallback(() => setOpen(true), []);
  const closeWindow = useCallback(() => setOpen(false), []);
  const toggleWindow = useCallback(() => setOpen(v => !v), []);
  const value = useMemo(
    () => ({ open, setOpen, openWindow, closeWindow, toggleWindow }),
    [open, openWindow, closeWindow, toggleWindow]
  );
  return <SwimCloudContext.Provider value={value}>{children}</SwimCloudContext.Provider>;
}

export function useSwimCloudWindow() {
  const ctx = useContext(SwimCloudContext);
  if (!ctx) {
    return {
      open: false,
      setOpen: () => {},
      openWindow: () => {},
      closeWindow: () => {},
      toggleWindow: () => {},
    };
  }
  return ctx;
}
