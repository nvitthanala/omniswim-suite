/**
 * Build-time constants that apps/extension/build.config.mjs defines for esbuild.
 */
export {};

declare global {
  /** True only in the harness build (`build.mjs --harness`, output `dist-harness/`). False in `dist/`. */
  const __OSX_HARNESS__: boolean;
}
