import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

export type MenuAlign = 'start' | 'end';

type MenuProps = {
  /** Accessible name for the trigger button and the menu itself. */
  label: string;
  /** Icon shown on the default trigger button. */
  icon?: ReactNode;
  /** Show `label` as visible text next to the icon on the trigger. Default false (icon-only). */
  showLabel?: boolean;
  /** Which side the panel hangs from. Default 'end' (right-aligned under the trigger). */
  align?: MenuAlign;
  /** Extra classes for the trigger button. */
  triggerClassName?: string;
  /** Extra classes for the menu panel. */
  panelClassName?: string;
  /** `MenuItem` elements (or any `role="menuitem"` content). */
  children: ReactNode;
};

/**
 * A minimal overflow/dropdown menu: a trigger button that opens a
 * `role="menu"` panel of `MenuItem`s. Closes on outside click, on Escape
 * (returning focus to the trigger), and on selecting any item. Arrow
 * up/down move focus between items while open.
 */
export function Menu({
  label,
  icon,
  showLabel = false,
  align = 'end',
  triggerClassName,
  panelClassName,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((refocusTrigger: boolean) => {
    setOpen(false);
    if (refocusTrigger) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        close(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(true);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + items.length) % items.length;
    items[nextIndex].focus();
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={
          triggerClassName ??
          'btn-ghost flex items-center gap-1.5 p-1.5 rounded-lg transition-colors'
        }
      >
        {icon}
        {showLabel ? <span className="text-ui-caption font-semibold">{label}</span> : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          onKeyDown={handlePanelKeyDown}
          onClick={() => close(false)}
          className={[
            'absolute top-full mt-2 min-w-[220px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 z-50',
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ boxShadow: 'var(--ui-shadow-md)' }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

type MenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> & {
  icon?: ReactNode;
  /** Whether this item represents a currently-active toggle (e.g. a panel that's open). */
  active?: boolean;
  /**
   * Called when this item is activated (clicked). Named `onSelect` rather
   * than relying on the native `onClick`, matching the convention menu
   * components elsewhere use (e.g. Radix's `DropdownMenuItem`) — the
   * native DOM `onSelect` event is an unrelated text-selection event that
   * a button never fires, so this prop is deliberately typed to shadow
   * and replace it rather than let it pass through unused via `...rest`.
   */
  onSelect?: () => void;
  children: ReactNode;
};

/** A single action inside a `Menu`. Renders as `role="menuitem"`. */
export function MenuItem({ icon, active, children, className, onSelect, onClick, ...rest }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={[
        'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-ui-caption text-left theme-hover-row transition-colors',
        active ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-pressed={active}
      onClick={event => {
        onClick?.(event);
        onSelect?.();
      }}
      {...rest}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}
