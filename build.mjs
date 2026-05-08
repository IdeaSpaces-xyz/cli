import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["dist/main.js"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "bundle/ideaspaces.js",
  // Some transitive CommonJS dependencies call dynamic require() at runtime.
  // ESM bundles need a real Node require binding so those paths work in
  // credential-helper invocations too.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  external: [],
});
