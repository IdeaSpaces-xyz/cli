import * as esbuild from "esbuild";
import { chmod } from "node:fs/promises";

const outfile = "bundle/ideaspaces.js";

await esbuild.build({
  entryPoints: ["dist/main.js"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile,
  // Some transitive CommonJS dependencies call dynamic require() at runtime.
  // ESM bundles need a real Node require binding so those paths work in
  // credential-helper invocations too.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  external: [],
});

// npm strips invalid bin entries during publication. esbuild creates files as
// 0644, so make the declared CLI entrypoint executable before packing it.
await chmod(outfile, 0o755);
