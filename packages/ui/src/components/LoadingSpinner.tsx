import { motion } from 'motion/react';
import { Waves } from 'lucide-react';

export function LoadingSpinner({ label }: { label?: string }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-[var(--bg)] min-h-[200px]">
      <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}>
        <Waves className="w-10 h-10 text-[var(--text-accent)]" />
      </motion.div>
      {label ? (
        <p className="text-ui-caption uppercase tracking-widest text-[var(--text-muted)] font-bold">{label}</p>
      ) : null}
    </div>
  );
}
