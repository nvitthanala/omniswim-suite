# Legacy suite

This folder holds the standalone OmniSwim suite that was superseded by the
Chrome extension redesign. It was frozen on 2026-10-25 and remains runnable for
reference and regression checks.

Run the standalone app with `npm run dev` or build it with `npm run build`.
The old extension builder is available with `npm run build:extension`.

Run the moved script and Vitest suites with `npm run test:legacy`. Run their
type and ESLint checks with `npm run lint:legacy`.
