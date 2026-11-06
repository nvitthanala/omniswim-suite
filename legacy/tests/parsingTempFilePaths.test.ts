import { describe, expect, it } from 'vitest';
import { createParsingTempFilePath } from '../apps/shell/lib/routes/parsingRoutes.ts';

describe('PDF temp file paths', () => {
  it('uses distinct cryptographically random names for concurrent uploads', () => {
    const first = createParsingTempFilePath('uploads');
    const second = createParsingTempFilePath('uploads');
    expect(first).not.toBe(second);
  });
});
