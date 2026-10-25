/**
 * `createElement` for a component whose `children` prop is required.
 *
 * React's typings do not count children passed as extra arguments toward a
 * required `children` prop, so `createElement(Modal, { onClose }, child)` fails
 * to type-check even though React treats it as `<Modal onClose>{child}</Modal>`.
 * This helper takes the props without `children` and the children as rest
 * arguments, and makes the same call. Runtime behaviour is unchanged.
 */
import { createElement, type ComponentType, type ReactElement, type ReactNode } from 'react';

export function elementWithChildren<P extends { children?: ReactNode }>(
  component: ComponentType<P>,
  props: Omit<P, 'children'> | null,
  ...children: ReactNode[]
): ReactElement {
  return createElement(component as ComponentType<Omit<P, 'children'>>, props, ...children);
}
