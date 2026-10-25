import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';

export type DisclosureProps = {
  /** The button label. It also names the panel. */
  title: ReactNode;
  /** Short status text shown beside the title, such as a count. */
  summary?: ReactNode;
  /** Icon shown before the title. */
  icon?: ReactNode;
  /** Initial state when uncontrolled. Default false (collapsed). */
  defaultOpen?: boolean;
  /** Controlled state. Pass `onOpenChange` too, or the control cannot move. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
};

/**
 * A button that shows and hides one panel. The button carries `aria-expanded`
 * and `aria-controls`; the panel is `role="region"` named by the button.
 * The panel stays mounted while collapsed (it is `hidden`), so state inside it
 * — a pasted draft, a scroll position — survives a collapse.
 */
export function Disclosure({
  title,
  summary,
  icon,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  className,
  children,
}: DisclosureProps) {
  const reactId = useId().replace(/:/g, '');
  const buttonId = `disclosure-button-${reactId}`;
  const panelId = `disclosure-panel-${reactId}`;
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : innerOpen;

  const toggle = () => {
    const next = !open;
    if (!isControlled) setInnerOpen(next);
    onOpenChange?.(next);
  };

  return (
    <section className={cn('surface-card rounded-xl border border-theme-soft', className)}>
      <h4 className="m-0">
        <button
          type="button"
          id={buttonId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
          className="flex w-full items-center gap-2.5 rounded-xl px-4 py-3 text-left text-ui-label font-semibold text-[var(--text-primary)] theme-hover-row transition-colors"
        >
          {icon ? <span className="shrink-0 text-[var(--text-accent)]">{icon}</span> : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {summary ? (
            <span className="shrink-0 text-ui-caption font-normal text-theme-muted">{summary}</span>
          ) : null}
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={cn(
              'shrink-0 text-theme-muted transition-transform duration-150 ease-out motion-reduce:transition-none',
              open && 'rotate-180'
            )}
          />
        </button>
      </h4>
      <div id={panelId} role="region" aria-labelledby={buttonId} hidden={!open}>
        <div className="border-t border-theme-soft px-4 pb-4 pt-3">{children}</div>
      </div>
    </section>
  );
}
