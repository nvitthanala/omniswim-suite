import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

/** Must match the transition duration on `.toast-item` in index.css. */
const TOAST_EXIT_MS = 200;

export type ToastKind = 'error' | 'success' | 'info';

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
};

type ToastContextValue = {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_ICON: Record<ToastKind, typeof Info> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts(list => list.filter(t => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = `toast-${++counter.current}`;
      setToasts(list => [...list, { id, kind, message }]);
      const ttl = kind === 'error' ? 7000 : 4000;
      window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

type ViewportToast = Toast & { exiting?: boolean };

/**
 * Keeps a toast mounted for one exit transition after it leaves `toasts`, so
 * dismissal plays the same translateY/opacity path in reverse instead of
 * teleporting out. `toasts` is the source of truth; this is purely a
 * render-lag buffer for the exit animation.
 */
function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const [items, setItems] = useState<ViewportToast[]>([]);
  const exitTimers = useRef(new Map<string, number>());

  useEffect(() => {
    setItems(current => {
      const incomingIds = new Set(toasts.map(t => t.id));
      const currentIds = new Set(current.map(t => t.id));
      const kept = current
        .filter(item => incomingIds.has(item.id) || !item.exiting)
        .map(item => (incomingIds.has(item.id) ? item : { ...item, exiting: true }));
      const added = toasts.filter(t => !currentIds.has(t.id));
      return [...kept, ...added];
    });
  }, [toasts]);

  useEffect(() => {
    const timers = exitTimers.current;
    items.forEach(item => {
      if (item.exiting && !timers.has(item.id)) {
        const timer = window.setTimeout(() => {
          setItems(current => current.filter(i => i.id !== item.id));
          timers.delete(item.id);
        }, TOAST_EXIT_MS);
        timers.set(item.id, timer);
      }
    });
    return () => {
      timers.forEach(timer => window.clearTimeout(timer));
      timers.clear();
    };
  }, [items]);

  if (items.length === 0) return null;
  return (
    <div className="toast-viewport" role="region" aria-label="Notifications">
      {items.map(item => (
        <ToastItem key={item.id} toast={item} exiting={item.exiting ?? false} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  exiting,
  onDismiss,
}: {
  toast: Toast;
  exiting: boolean;
  onDismiss: (id: string) => void;
}) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    // Start from the offscreen state, then flip on the next frame so the
    // browser has a "from" value to transition away from (no @starting-style
    // dependency, which not every target browser here supports yet).
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const Icon = KIND_ICON[toast.kind];
  const state = exiting ? 'exiting' : entered ? 'entered' : 'entering';

  return (
    <div className={`toast-item toast-${toast.kind}`} data-state={state} role="status">
      <Icon size={16} className="toast-icon" />
      <span className="toast-message">{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fall back to console so applets used outside the provider don't crash.
    return {
      toasts: [],
      push: (kind, message) => console[kind === 'error' ? 'error' : 'log'](message),
      dismiss: () => undefined,
    };
  }
  return ctx;
}
