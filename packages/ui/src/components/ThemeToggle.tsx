import { Moon, Sun } from 'lucide-react';
import { Button } from './Button';

type Props = {
  theme: 'dark' | 'light';
  onToggle: () => void;
  className?: string;
};

export function ThemeToggle({ theme, onToggle, className }: Props) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onToggle}
      className={`theme-toggle-button p-2${className ? ` ${className}` : ''}`}
      aria-label="Toggle color mode"
      leadingIcon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    />
  );
}
