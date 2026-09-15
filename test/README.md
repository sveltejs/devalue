# Testing

The test suite uses Vitest with an explicit Node project named `unit`.

- `pnpm test` runs the unit suite once.
- `pnpm test:unit` is the explicit unit-suite command.
- `pnpm test:watch` runs the unit suite in watch mode.
- `pnpm test:types` type-checks the JavaScript source with TypeScript.

Unit tests are discovered from `src/**/*.test.js` and `test/**/*.test.js`. Browser tests use a separate project and are excluded from unit discovery.

The base64 and string-escaping tests include independent decoder and UTF-8 transport checks. Keep these independent from encoder round trips so correlated encoding and decoding regressions cannot hide each other.
