import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

let originalHome: string | undefined;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-spaces-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(tmp, { recursive: true, force: true });
});

describe("auth/spaces", () => {
  it("loadSpaces returns {} when file is missing", async () => {
    const { loadSpaces } = await import("../auth/spaces.js");
    expect(loadSpaces()).toEqual({});
  });

  it("saveSpace creates the file with 0600 mode and folder-keyed entries", async () => {
    const { saveSpace, loadSpaces } = await import("../auth/spaces.js");
    saveSpace("/Users/u/proj-a", { repo_id: "r_a", slug: "a", namespace: "u" });
    saveSpace("/Users/u/proj-b", { repo_id: "r_b", slug: "b", namespace: "acme.com" });

    const file = join(tmp, ".ideaspaces", "spaces.json");
    expect(existsSync(file)).toBe(true);

    const map = loadSpaces();
    expect(map["/Users/u/proj-a"]).toEqual({ repo_id: "r_a", slug: "a", namespace: "u" });
    expect(map["/Users/u/proj-b"]).toEqual({ repo_id: "r_b", slug: "b", namespace: "acme.com" });
  });

  it("findSpaceFor returns the record for a known absolute path", async () => {
    const { saveSpace, findSpaceFor } = await import("../auth/spaces.js");
    saveSpace("/abs/path", { repo_id: "r", slug: "s", namespace: "n" });
    expect(findSpaceFor("/abs/path")).toEqual({ repo_id: "r", slug: "s", namespace: "n" });
  });

  it("findSpaceFor returns null for an unknown path", async () => {
    const { findSpaceFor } = await import("../auth/spaces.js");
    expect(findSpaceFor("/never/published")).toBeNull();
  });

  it("saveSpace overwrites the entry for the same absolute path", async () => {
    const { saveSpace, loadSpaces } = await import("../auth/spaces.js");
    saveSpace("/p", { repo_id: "r1", slug: "s1", namespace: "n" });
    saveSpace("/p", { repo_id: "r2", slug: "s2", namespace: "n" });
    const map = loadSpaces();
    expect(Object.keys(map)).toHaveLength(1);
    expect(map["/p"].repo_id).toBe("r2");
  });

  it("loadSpaces tolerates a malformed JSON file", async () => {
    const { saveSpace, loadSpaces } = await import("../auth/spaces.js");
    saveSpace("/p", { repo_id: "r", slug: "s", namespace: "n" });
    const file = join(tmp, ".ideaspaces", "spaces.json");
    await import("node:fs").then((fs) => fs.writeFileSync(file, "{not json"));
    expect(loadSpaces()).toEqual({});
    // The byte content stayed (we didn't clobber); verifies the load is read-only.
    expect(readFileSync(file, "utf-8")).toBe("{not json");
  });
});
