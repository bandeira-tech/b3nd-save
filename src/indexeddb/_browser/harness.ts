/**
 * Browser entry point for the IndexedDBStore real-browser test
 * harness. Bundled by `indexeddb/integration.test.ts` (which uses
 * the generic runner under `tests/runners/`).
 *
 * The first import wires up `globalThis.Deno.test` collection.
 * The shared store suite then registers tests against the real
 * browser IndexedDB.
 */

import { setupHarness } from "../../../tests/helpers/browser-deno-stub.ts";
import { IndexedDBStore } from "../store.ts";
import { runSharedStoreSuite } from "../../../tests/runners/shared-store-suite.ts";

let testCount = 0;

runSharedStoreSuite("IndexedDBStore (browser)", {
  create: () =>
    new IndexedDBStore({
      databaseName: `b3nd-browser-test-${Date.now()}-${++testCount}`,
    }),
  // v2 §3.5: IndexedDBStore ships fn=find (this PR's main change).
  supportsFind: true,
});

setupHarness();
