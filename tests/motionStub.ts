/**
 * happy-dom cancels Web Animations with an AbortError that surfaces as an
 * unhandled rejection. Tests that render a `motion` component use this stub, so
 * they test the component's behaviour and not the animation library.
 *
 * Use as: vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);
 */
import { createElement, Fragment, forwardRef, type ReactNode } from 'react';

const MOTION_ONLY_PROPS = new Set([
  'initial', 'animate', 'exit', 'transition', 'variants', 'layout', 'layoutId', 'whileHover', 'whileTap', 'whileFocus',
  'whileInView', 'custom', 'onAnimationComplete',
]);

const motion = new Proxy({}, {
  get: (_target, tag: string) =>
    forwardRef<HTMLElement, Record<string, unknown>>(function MotionStub(props, ref) {
      const rest = Object.fromEntries(Object.entries(props).filter(([key]) => !MOTION_ONLY_PROPS.has(key)));
      return createElement(tag, { ...rest, ref });
    }),
});

export const motionStub = {
  motion,
  AnimatePresence: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
};
