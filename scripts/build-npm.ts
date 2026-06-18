#!/usr/bin/env -S deno run -A
// deno-lint-ignore-file no-import-prefix
/**
 * Build an NPM package from the Deno source via @deno/dnt.
 *
 * Output: ./npm/  — published as `@bandeira-tech/b3nd-save` on
 * npmjs.com. Same import surface as JSR.
 *
 * Each subpath is environment-specific by design:
 *   - postgres / mongo / sqlite / fs / ipfs / s3 / elasticsearch  → Node
 *   - indexeddb / localstorage                                    → browser
 *   - clients / memory / errors / payload / read / dispatch       → both
 */

import { build, emptyDir } from "jsr:@deno/dnt@^0.42.1";

const denoJson = JSON.parse(await Deno.readTextFile("./deno.json"));
const version = denoJson.version as string;

await emptyDir("./npm");

await build({
  entryPoints: [
    { name: ".", path: "./src/mod.ts" },
    { name: "./clients", path: "./src/clients/mod.ts" },
    { name: "./errors", path: "./src/errors.ts" },
    { name: "./payload", path: "./src/payload.ts" },
    { name: "./read", path: "./src/read.ts" },
    { name: "./dispatch", path: "./src/dispatch.ts" },
    { name: "./memory", path: "./src/memory/mod.ts" },
    { name: "./postgres", path: "./src/postgres/mod.ts" },
    { name: "./mongo", path: "./src/mongo/mod.ts" },
    { name: "./sqlite", path: "./src/sqlite/mod.ts" },
    { name: "./fs", path: "./src/fs/mod.ts" },
    { name: "./ipfs", path: "./src/ipfs/mod.ts" },
    { name: "./s3", path: "./src/s3/mod.ts" },
    { name: "./elasticsearch", path: "./src/elasticsearch/mod.ts" },
    { name: "./localstorage", path: "./src/localstorage/mod.ts" },
    { name: "./indexeddb", path: "./src/indexeddb/mod.ts" },
  ],
  outDir: "./npm",
  shims: { deno: false },
  test: false,
  scriptModule: false,
  // dnt 0.42.3 emits `_dnt.polyfills.ts` that references `require`/`module`
  // for runtime CJS/ESM detection. The deno source is already type-checked
  // via `deno task check`; skip dnt's redundant npm-side typecheck so the
  // polyfill doesn't fail without `@types/node` in lib.
  typeCheck: "none",
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
  },
  // TODO: once @bandeira-tech/b3nd-core is on npm, map the JSR core
  // dep so dnt declares it as a peer dep instead of vendoring its
  // source. Until then, the npm build will inline a copy of core's
  // types — small footprint, but suboptimal.
  package: {
    name: "@bandeira-tech/b3nd-save",
    version,
    description: denoJson.description,
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/bandeira-tech/b3nd-save.git",
    },
    bugs: {
      url: "https://github.com/bandeira-tech/b3nd-save/issues",
    },
    homepage: "https://github.com/bandeira-tech/b3nd-save#readme",
    engines: {
      node: ">=20",
    },
    sideEffects: false,
    publishConfig: {
      access: "public",
    },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");

    const pkgPath = "npm/package.json";
    const pkg = JSON.parse(Deno.readTextFileSync(pkgPath));
    for (const [name, entry] of Object.entries(pkg.exports)) {
      const e = entry as { import?: string; types?: string };
      if (e.import && !e.types) {
        e.types = e.import.replace(/\.js$/, ".d.ts");
        pkg.exports[name] = { types: e.types, import: e.import };
      }
    }
    Deno.writeTextFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  },
});

console.log(`\n✔ Built @bandeira-tech/b3nd-save@${version} → ./npm/`);
