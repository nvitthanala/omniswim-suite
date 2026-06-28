import { Moon, Sun } from 'lucide-react';

type Props = {
  theme: 'dark' | 'light';
  onToggle: () => void;
  className?: string;
};

export function ThemeToggle({ theme, onToggle, className }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`theme-toggle-button p-2 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors${className ? ` ${className}` : ''}`}
      aria-label="Toggle color mode"
    >
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
