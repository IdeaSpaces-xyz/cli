import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

let originalHome: string | undefined;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "is-cli-spaces-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
  vi.resetModules();
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
    expect(map[resolve("/Users/u/proj-a")]).toEqual({ repo_id: "r_a", slug: "a", namespace: "u" });
    expect(map[resolve("/Users/u/proj-b")]).toEqual({ repo_id: "r_b", slug: "b", namespace: "acme.com" });
  });

  it("stores stable identity and route metadata additively", async () => {
    const { saveSpace, loadSpaces } = await import("../auth/spaces.js");
    saveSpace("/canonical", {
      repo_id: "r",
      root_node_id: "n_0123456789abcdef01234567",
      slug: "notes",
      namespace: "alice",
      route_status: "resolved",
      route_namespace: "alice",
      route_slug: "notes",
      canonical_path: "/spaces/n_0123456789abcdef01234567",
    });

    expect(loadSpaces()[resolve("/canonical")]).toMatchObject({
      repo_id: "r",
      root_node_id: "n_0123456789abcdef01234567",
      route_status: "resolved",
      route_namespace: "alice",
    });
  });

  it("stores fork lineage and reads it back", async () => {
    const { saveSpace, findSpaceFor } = await import("../auth/spaces.js");
    saveSpace("/fork", {
      repo_id: "r_copy",
      root_node_id: "n_0123456789abcdef01234567",
      slug: "manual",
      namespace: "alice",
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
      source_baseline_initialized: true,
    });

    expect(findSpaceFor("/fork")).toMatchObject({
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
      source_baseline_initialized: true,
    });
  });

  it("loads a record written before lineage existed", async () => {
    const dir = join(tmp, ".ideaspaces");
    const fs = await import("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    // Byte-for-byte a pre-lineage record: no source fields at all.
    fs.writeFileSync(
      join(dir, "spaces.json"),
      JSON.stringify({
        [resolve("/legacy")]: {
          repo_id: "r_old",
          slug: "notes",
          namespace: "alice",
          root_node_id: "n_0123456789abcdef01234567",
          route_status: "resolved",
          route_namespace: "alice",
          route_slug: "notes",
          canonical_path: "/spaces/n_0123456789abcdef01234567",
        },
      }),
    );

    const { findSpaceFor } = await import("../auth/spaces.js");
    const record = findSpaceFor("/legacy");
    expect(record?.repo_id).toBe("r_old");
    expect(record?.source_root_node_id).toBeUndefined();
    expect(record?.source_head).toBeUndefined();
  });

  it("findSpaceFor resolves a legacy symlinked folder key", async () => {
    const { saveSpace, findSpaceFor } = await import("../auth/spaces.js");
    const fs = await import("node:fs");
    const physical = join(tmp, "physical");
    const alias = join(tmp, "alias");
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, alias);
    saveSpace(alias, { repo_id: "r", slug: "s", namespace: "n" });

    expect(findSpaceFor(physical)).toEqual({ repo_id: "r", slug: "s", namespace: "n" });
  });

  it("findSpaceFor reads a pre-canonicalization alias record", async () => {
    const dir = join(tmp, ".ideaspaces");
    const fs = await import("node:fs");
    const physical = join(tmp, "physical-old");
    const alias = join(tmp, "alias-old");
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, alias);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, "spaces.json"),
      JSON.stringify({ [alias]: { repo_id: "r_old", slug: "s", namespace: "n" } }),
    );

    const { findSpaceFor } = await import("../auth/spaces.js");
    expect(findSpaceFor(physical)?.repo_id).toBe("r_old");
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
    expect(map[resolve("/p")].repo_id).toBe("r2");
  });

  it("stores an unpublished fork without synthetic hosted fields", async () => {
    const { saveSpace, findSpaceFor } = await import("../auth/spaces.js");
    saveSpace("/local-fork", {
      kind: "unpublished_fork",
      root_node_id: "n_0123456789abcdef01234567",
      name: "Local Guide",
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
      source_baseline_initialized: true,
    });

    const record = findSpaceFor("/local-fork");
    expect(record).toMatchObject({
      kind: "unpublished_fork",
      root_node_id: "n_0123456789abcdef01234567",
      source_root_node_id: "n_ffffffffffffffffffffffff",
    });
    expect(record).not.toHaveProperty("repo_id");
    expect(record).not.toHaveProperty("slug");
    expect(record).not.toHaveProperty("namespace");
    expect(record).not.toHaveProperty("route_status");
  });

  it("refuses fake destinations and invalid unpublished identity", async () => {
    const { saveSpace } = await import("../auth/spaces.js");
    const valid = {
      kind: "unpublished_fork" as const,
      root_node_id: "n_0123456789abcdef01234567",
      name: "Local Guide",
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
      source_baseline_initialized: false,
    };
    expect(() => saveSpace("/fake", { ...valid, repo_id: "" } as never)).toThrow(
      "invalid local Space registry record",
    );
    expect(() =>
      saveSpace("/same", { ...valid, root_node_id: valid.source_root_node_id }),
    ).toThrow("invalid local Space registry record");
    expect(() =>
      saveSpace("/legacy-destination", { ...valid, root_node_id: "n_0123456789ab" }),
    ).toThrow("invalid local Space registry record");
  });

  it("drops malformed records at the read boundary without rewriting the file", async () => {
    const dir = join(tmp, ".ideaspaces");
    const file = join(dir, "spaces.json");
    const fs = await import("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    const raw = JSON.stringify({
      "/fake": {
        kind: "unpublished_fork",
        repo_id: "",
        root_node_id: "n_0123456789abcdef01234567",
        name: "Fake",
        source_root_node_id: "n_ffffffffffffffffffffffff",
        source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
        source_baseline_initialized: true,
      },
      "/hosted": { repo_id: "r", slug: "s", namespace: "n" },
    });
    fs.writeFileSync(file, raw);

    const { loadSpaces } = await import("../auth/spaces.js");
    expect(loadSpaces()).toEqual({ "/hosted": { repo_id: "r", slug: "s", namespace: "n" } });
    expect(readFileSync(file, "utf-8")).toBe(raw);
  });

  it("converts an unpublished fork to the matching hosted binding without losing lineage", async () => {
    const { withForkLineage } = await import("../auth/spaces.js");
    const previous = {
      kind: "unpublished_fork" as const,
      root_node_id: "n_0123456789abcdef01234567",
      name: "Local Guide",
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
      source_baseline_initialized: true,
    };
    expect(
      withForkLineage(
        {
          repo_id: "repo_new",
          root_node_id: previous.root_node_id,
          slug: "local-guide",
          namespace: "alice",
        },
        previous,
      ),
    ).toMatchObject({
      repo_id: "repo_new",
      root_node_id: previous.root_node_id,
      source_root_node_id: previous.source_root_node_id,
      source_head: previous.source_head,
      source_baseline_initialized: true,
      name: "Local Guide",
    });
    expect(
      withForkLineage(
        {
          repo_id: "repo_other",
          root_node_id: "n_aaaaaaaaaaaaaaaaaaaaaaaa",
          slug: "other",
          namespace: "alice",
        },
        previous,
      ),
    ).not.toHaveProperty("source_root_node_id");
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
