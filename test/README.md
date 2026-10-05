# Testing

The test suite uses Vitest with an explicit Node project named `unit`.

- `pnpm test` runs the unit suite once.
- `pnpm test:unit` is the explicit unit-suite command.
- `pnpm test:watch` runs the unit suite in watch mode.
- `pnpm test:types` type-checks the JavaScript source with TypeScript.

Unit tests are discovered from `src/**/*.test.js` and `test/**/*.test.js`. Browser tests use a separate project and are excluded from unit discovery.

The base64 and string-escaping tests include independent decoder and UTF-8 transport checks. Keep these independent from encoder round trips so correlated encoding and decoding regressions cannot hide each other.

`unevalStream` tests go through `expect_roundtrip(make, { replacer, globals, orders })` in `test/helpers/stream.js`. `make` receives a schedule whose `later(value)` and `later_reject(reason)` create promises that the harness settles in several orders (FIFO, LIFO, all at once, seeded shuffle). For each order, the harness evaluates the head and every tail block in fresh VM realms, both separately and concatenated into one script. It awaits every revived promise and checks structure and identity with `compare_topology`. It also asserts that the head is the same for every order, that the replacer was called once per object identity, and that the client session was deleted. New cases should be rows in the existing tables. Don't assert exact `head` strings except in escaping regressions.

Use `test.each` for independent input cases and `describe.each` for suites or nested case matrices. Wrap array-valued inputs in object rows so Vitest does not spread them into callback arguments, and create mutable values inside each test. Loops within a test are appropriate for building fixtures, checking one result's contents, or comparing growth across input sizes.
