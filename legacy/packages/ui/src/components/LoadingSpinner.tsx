import { motion, useReducedMotion } from 'motion/react';
import { Waves } from 'lucide-react';

export function LoadingSpinner({ label }: { label?: string }) {
  // Constant motion (a spin) gets `linear` easing so it reads as continuous
  // progress, not a decelerating gesture. Reduced motion keeps the icon
  // static and falls back to a gentle opacity pulse — the loading state
  // stays legible without the movement.
  const reduce = useReducedMotion();
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-[var(--bg)] min-h-[200px]">
      <motion.div
        animate={reduce ? { opacity: [0.4, 1, 0.4] } : { rotate: 360 }}
        transition={
          reduce
            ? { duration: 1.6, repeat: Infinity, ease: 'linear' }
            : { duration: 1, repeat: Infinity, ease: 'linear' }
        }
      >
        <Waves className="w-10 h-10 text-[var(--text-accent)]" />
      </motion.div>
      {label ? (
        <p className="text-ui-caption uppercase tracking-widest text-[var(--text-muted)] font-bold">{label}</p>
      ) : null}
    </div>
  );
}
