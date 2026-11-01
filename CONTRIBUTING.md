# Contributing

## Setup

Node.js 22.18 or later for development (the published package supports Node.js 20+), and npm.

```bash
npm install
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Bundles `src/` into `dist/` with tsdown: ESM, CommonJS and declarations for both. |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/`. |
| `npm test` | Runs the Vitest suite twice: with the runtime's Web Locks, then with `navigator.locks` removed, so the lease fallback is tested too. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:dist` | Loads the built package through its `exports` map, as an ESM and a CommonJS consumer would, including both builds side by side. Run `npm run build` first. |
| `npm run check:package` | publint and arethetypeswrong on the packed package. |
| `node scripts/diagrams.mjs` | Renders the README diagrams to `docs/images/`, light and dark. Needs Playwright's Chromium: `npx playwright install chromium`. |

`prepublishOnly` runs all of them in that order: typecheck, tests, build, the built-package smoke tests and the package checks.

## Layout

```
src/
  index.ts          public exports
  guard.ts          createOrynth(): options, define(), restore(), clear()
  operation.ts      the Operation handle: execution, retries, reconciliation, Web Locks and
                    leases, input fingerprints and the stored copy of the input
  recovery.ts       stored records: building, validating and restoring them
  registry.ts       one handle per operation ID within an instance
  lifecycle.ts      the allowed state transitions
  classify.ts       isUncertainError(), the default classification of errors
  retry.ts          retry policy and backoff
  validate.ts       option validation
  errors.ts         error classes, with instanceof across copies of the package
  id.ts             random IDs and idempotency keys
  types.ts          public types
  storage/          memoryStorage() and indexedDBStorage()
test/
  *.test.ts         unit, HTTP (fetch, Axios, Ky and ofetch against a local server),
                    IndexedDB (fake-indexeddb), cross-tab and regression tests
  clients.test.ts   the release test for every client in docs/http-clients.md: its
                    recipes are copied there, so change both together
  helpers.ts        fault-injection helpers: dropped connections, failing storage, deferreds
  server.ts         a local order API that honors idempotency keys like the IETF draft
  setup/no-locks.ts removes navigator.locks for the second test run
scripts/            the built-package smoke tests (test:dist) and the diagram generator
docs/               user documentation; images/ holds the logo and the rendered diagrams
```

## Tests

- Tabs are simulated with several instances sharing one storage. Tests that involve other tabs run with Web Locks and with leases (`describe.each` over both modes).
- Node.js 22 has no `navigator.locks`, so there both runs of `npm test` use leases and the Web Locks-only tests are skipped. Use a Node.js version that has it (26 does) to cover both.
- A test for a bug should fail without the fix. Check that before committing it.

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Before a release, install the packed package (`npm pack`) into a real app and test it end to end in browsers.
3. Publish a GitHub release tagged `vX.Y.Z`. The Release workflow publishes to npm with provenance; `prepublishOnly` runs every check first.

The workflow uses npm trusted publishing, which is set up in the package's settings on npmjs.com. If npm doesn't allow that before the package exists, publish the first version from your machine with `npm publish`, then set it up for later releases.
