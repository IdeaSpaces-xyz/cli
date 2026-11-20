// The environment one isolated test run gets (scripts/test-isolated.mjs). Kept apart from the runner
// so scripts/test-isolation.test.ts can check it without starting a second suite.
//
// A run gets its own folders under its root, and loses every variable that can carry the person's
// session, sign-in or repository into a test. A run started from inside the app, a Claude Code or Pi
// session, or a Git hook then sees what CI sees. Two runs on one Mac can't share a temp file.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Variables a run never inherits: the app's and the CLI's session, agent harnesses, provider keys,
 *  the Git repository a hook runs in, the heavy-test lock a stopped session holds, the XDG folders. */
export const CLEARED = [
  /^IDEASPACES_/, /^IDEA_EXPLORER_/, /^IS_/, /^PI_/, /^CLAUDE/, /^ANTHROPIC_/, /^OPENAI_/, /^AWS_/,
  /^GIT_/, /^XDG_/, /^HEAVY_TEST_LOCK$/, /^IE_TEST_/,
];

export const cleared = (name) => CLEARED.some((pattern) => pattern.test(name));

/** Make the run's folders under `root` and return its environment. `root` is new and empty. */
export function isolatedEnv(inherited, root, platform = process.platform) {
  const home = join(root, "home"), tmp = join(root, "tmp"), xdg = join(root, "xdg");
  const global = join(root, "git", "global.gitconfig"), system = join(root, "git", "system.gitconfig");
  for (const dir of [home, tmp, join(xdg, "config"), join(xdg, "data"), join(xdg, "cache"), join(xdg, "state"), join(root, "git")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(global, ""); writeFileSync(system, "");
  const env = Object.fromEntries(Object.entries(inherited).filter(([name, value]) => value !== undefined && !cleared(name)));
  Object.assign(env, {
    IS_TEST_RUN_ROOT: root,
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(xdg, "config"), XDG_DATA_HOME: join(xdg, "data"),
    XDG_CACHE_HOME: join(xdg, "cache"), XDG_STATE_HOME: join(xdg, "state"),
    GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: system,
  });
  if (platform === "win32") {
    // os.homedir() and os.tmpdir() read these on Windows, not HOME and TMPDIR.
    Object.assign(env, { USERPROFILE: home, TEMP: tmp, TMP: tmp, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") });
    mkdirSync(env.APPDATA, { recursive: true }); mkdirSync(env.LOCALAPPDATA, { recursive: true });
  }
  return env;
}
