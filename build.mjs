import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["dist/main.js"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "bundle/ideaspaces.js",
  banner: { js: "#!/usr/bin/env node" },
  external: [],
});
