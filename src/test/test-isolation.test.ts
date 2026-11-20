// What makes two `npm test` runs safe side by side (scripts/test-isolated.mjs): each run's own
// HOME, temp folder and Git config under its own root, none of the person's session variables, and
// no test that binds a fixed port.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleared, isolatedEnv } from "../../scripts/test-isolation-env.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("an isolated run's environment", () => {
  const inherited = {
    PATH: "/usr/bin", LANG: "C", CI: "true",
    HOME: "/Users/someone", TMPDIR: "/var/folders/x/T/",
    IDEASPACES_AUTH: "host", IDEASPACES_READER: "someone", IDEA_EXPLORER_CONNECTOR_FD: "3",
    IS_API_KEY: "a-person's-key", IS_API_URL: "https://elsewhere.example", PI_CODING_AGENT_DIR: "/Users/someone/.pi",
    CLAUDE_CONFIG_DIR: "/Users/someone/.claude", CLAUDECODE: "1", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", AWS_PROFILE: "p",
    GIT_DIR: "/Users/someone/repo/.git", GIT_INDEX_FILE: "/Users/someone/repo/.git/index", GIT_CONFIG_GLOBAL: "/Users/someone/.gitconfig",
    XDG_CONFIG_HOME: "/Users/someone/.config", HEAVY_TEST_LOCK: "/tmp/ideaspaces-heavy-tests.lock",
  };

  it("keeps what a test needs and drops the person's session, keys and repository", () => {
    const root = mkdtempSync(join(tmpdir(), "isolation-env-"));
    try {
      const env = isolatedEnv(inherited, root, "darwin");
      expect(env).toMatchObject({ PATH: "/usr/bin", LANG: "C", CI: "true", IS_TEST_RUN_ROOT: root });
      for (const name of ["IDEASPACES_AUTH", "IDEASPACES_READER", "IDEA_EXPLORER_CONNECTOR_FD", "IS_API_KEY", "IS_API_URL", "PI_CODING_AGENT_DIR",
        "CLAUDE_CONFIG_DIR", "CLAUDECODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_PROFILE", "GIT_DIR", "GIT_INDEX_FILE", "HEAVY_TEST_LOCK"]) {
        expect(env, name).not.toHaveProperty(name);
      }
      for (const name of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
        expect(env[name], name).toMatch(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        expect(statSync(env[name]).isDirectory() || statSync(env[name]).isFile(), name).toBe(true);
      }
      expect(readFileSync(env.GIT_CONFIG_GLOBAL, "utf8")).toBe("");
      expect(env).not.toHaveProperty("USERPROFILE");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("on Windows, points USERPROFILE, TEMP, TMP and AppData into the run as well", () => {
    const root = mkdtempSync(join(tmpdir(), "isolation-env-"));
    try {
      const env = isolatedEnv({ ...inherited, USERPROFILE: "C:\\Users\\someone", TEMP: "C:\\T", APPDATA: "C:\\A" }, root, "win32");
      for (const name of ["USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) expect(env[name].startsWith(root), name).toBe(true);
      expect(env.USERPROFILE).toBe(env.HOME);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// `npm test` sets IS_TEST_RUN_ROOT. A bare `npx vitest` doesn't, so this part runs only under the
// runner, and CI always uses the runner.
const runRoot = process.env.IS_TEST_RUN_ROOT;
describe.skipIf(!runRoot && !process.env.CI)("this run", () => {
  it("was started by the isolated runner", () => {
    expect(runRoot, "run the suite with `npm test`, not bare vitest").toBeTruthy();
  });
  it("has its own home and temp folder under its root", () => {
    expect(realpathSync(homedir()).startsWith(realpathSync(runRoot!))).toBe(true);
    expect(realpathSync(tmpdir()).startsWith(realpathSync(runRoot!))).toBe(true);
  });
  it("inherited none of the session variables the runner clears", () => {
    // The setup files set these again, under this run's temp folder.
    const setHere = new Set(["IS_TEST_RUN_ROOT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "IDEASPACES_NO_UPDATE_CHECK",
      "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]);
    expect(Object.keys(process.env).filter((name) => cleared(name) && !setHere.has(name))).toEqual([]);
    const real = (path: string) => existsSync(path) ? realpathSync(path) : path;
    for (const name of setHere) if (name !== "IDEASPACES_NO_UPDATE_CHECK" && process.env[name]) expect(real(process.env[name]!).startsWith(real(runRoot!)), name).toBe(true);
  });
});

describe("ports", () => {
  it("no test binds a fixed port: two runs would collide on it", () => {
    const fixed = /\.listen\(\s*(?:\{[^}]*\bport:\s*)?[1-9]\d{1,4}\b/;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", "bundle", ".git"].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.test\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
          readFileSync(path, "utf8").split("\n").forEach((line, index) => {
            if (fixed.test(line)) found.push(`${relative(repo, path).split(sep).join("/")}:${index + 1}`);
          });
        }
      }
    };
    walk(repo);
    expect(found, "listen on port 0 and read the port the server got").toEqual([]);
  });
});
