/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `cn()` merges class strings with tailwind-merge. The `text-ui-*` size tokens
 * are plain CSS classes, so stock tailwind-merge reads them as text colours and
 * drops one of a size token and a colour class. These tests keep both.
 */
import { describe, expect, it } from 'vitest';
import { cn } from '../packages/ui/src/lib/cn';

describe('cn and the text-ui size tokens', () => {
  it('keeps a size token and a colour class, in either order', () => {
    expect(cn('text-ui-micro', 'text-theme-secondary').split(' ').sort()).toEqual(['text-theme-secondary', 'text-ui-micro']);
    expect(cn('text-red-300', 'text-ui-caption').split(' ').sort()).toEqual(['text-red-300', 'text-ui-caption']);
  });

  it('lets a later size token replace an earlier one', () => {
    expect(cn('text-ui-micro font-bold', 'text-ui-body')).toBe('font-bold text-ui-body');
    expect(cn('text-sm', 'text-ui-label')).toBe('text-ui-label');
  });

  it('still lets a later colour replace an earlier colour', () => {
    expect(cn('text-theme-muted', 'text-red-300')).toBe('text-red-300');
  });
});
