/**
 * This CLI's own version. `build.mjs` writes it into the bundle from package.json,
 * because the app and the plugin carry the bundle alone, with no package.json beside it.
 * Unbundled (`dist/`, tests) it is the dev version, which no check treats as current.
 */
declare const __IDEASPACES_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __IDEASPACES_CLI_VERSION__ === "string" ? __IDEASPACES_CLI_VERSION__ : "0.0.0-dev";
