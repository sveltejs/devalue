# Testing

The test suite uses Vitest with an explicit Node project named `unit`.

- `pnpm test` runs the unit suite and the performance suite once.
- `pnpm test:unit` is the explicit unit-suite command.
- `pnpm test:perf` runs the deterministic performance project (`test/stream-performance.test.js` only).
- `pnpm test:watch` runs the unit suite in watch mode.
- `pnpm test:types` type-checks the JavaScript source with TypeScript, then compiles the public-API type tests in `type-tests/` (build first: those resolve `devalue` to the generated `types/index.d.ts`).

Unit tests are discovered from `src/**/*.test.js` and `test/**/*.test.js`; `test/stream-performance.test.js` belongs to the separate `performance` project, and browser tests use their own project. Both are excluded from unit discovery.

The base64 and string-escaping tests include independent decoder and UTF-8 transport checks. Keep these independent from encoder round trips so correlated encoding and decoding regressions cannot hide each other.

Use `test.each` for independent input cases and `describe.each` for suites or nested case matrices. Wrap array-valued inputs in object rows so Vitest does not spread them into callback arguments, and create mutable values inside each test. Loops within a test are appropriate for building fixtures, checking one result's contents, or comparing growth across input sizes.

The streaming tests run as ordinary Node processes: `test/stream*.test.js` plus the `src/graph`, `src/stream-runtime`, and `src/stream-source` units use real VM realms, real timers, child processes, and zlib. Keep subprocess fixtures under `fixtures/stream/` isolated (they observe process-wide unhandled rejections or run under `--unhandled-rejections=strict`), and never inspect hostile error values or revoked proxies with deep matchers — compare caught values directly instead. `test/stream-browser-harness.test.js` exercises deliberate child-termination delays; it relies on the suite's finite per-test timeout and is temporary harness coverage rather than product behavior.

The performance project holds generous deterministic byte budgets and bounded lookup/copy probes with ~25% headroom over measured output, printing actual raw sizes on failure. Its purpose is catching accidental expansion — duplicated runtime helpers, per-outcome anchors, whole-container copies — never forbidding more compact output; real wall-clock comparisons stay under `pnpm bench`. CI runs the unit suite on every supported Node lane and the performance project once on Node 24.
