import * as esbuild from "esbuild";
import { chmod, readFile, mkdir } from "node:fs/promises";
import { generateCatalog } from "./scripts/agent-tools.mjs";
import { checkSourceFlags } from "./scripts/check-agent-tools.mjs";

const outfile = "bundle/ideaspaces.js";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("bundle", { recursive: true });
checkSourceFlags();
const catalog = generateCatalog();

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
  // The app and the plugin carry this file alone, so the version has to live inside it.
  define: { __IDEASPACES_CLI_VERSION__: JSON.stringify(version), __IDEASPACES_AGENT_CATALOG__: JSON.stringify(catalog) },
});

// npm strips invalid bin entries during publication. esbuild creates files as
// 0644, so make the declared CLI entrypoint executable before packing it.
await chmod(outfile, 0o755);
