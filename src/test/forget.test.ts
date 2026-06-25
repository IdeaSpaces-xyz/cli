import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { removeSpaceMock, rmSyncMock, homedirMock } = vi.hoisted(() => ({
  removeSpaceMock: vi.fn(),
  rmSyncMock: vi.fn(),
  homedirMock: vi.fn(() => "/Users/test"),
}));

vi.mock("../auth/spaces.js", () => ({ removeSpace: removeSpaceMock }));
vi.mock("node:fs", async (importActual) => ({
  ...(await importActual<typeof import("node:fs")>()),
  rmSync: rmSyncMock,
}));
vi.mock("node:os", async (importActual) => ({
  ...(await importActual<typeof import("node:os")>()),
  homedir: homedirMock,
}));

const { forgetCommand } = await import("../commands/forget.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  removeSpaceMock.mockReset();
  rmSyncMock.mockReset();
  stdoutChunks = [];
  stderrChunks = [];
  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown as (s: string) => boolean) = (c: string | Uint8Array) => {
    stdoutChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf-8"));
    return true;
  };
  (process.stderr.write as unknown as (s: string) => boolean) = (c: string | Uint8Array) => {
    stderrChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf-8"));
    return true;
  };
});

afterEach(() => {
  (process.stdout.write as unknown as typeof originalOut) = originalOut;
  (process.stderr.write as unknown as typeof originalErr) = originalErr;
});

const stdout = () => stdoutChunks.join("");

describe("forget", () => {
  it("removes the binding and keeps files without --delete", async () => {
    removeSpaceMock.mockReturnValue(true);

    const code = await forgetCommand.run(["/Users/a/notes"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(removeSpaceMock).toHaveBeenCalledWith("/Users/a/notes");
    expect(rmSyncMock).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({ forgotten: true, deleted: false });
  });

  it("deletes the folder with --delete", async () => {
    removeSpaceMock.mockReturnValue(true);

    const code = await forgetCommand.run(["/Users/a/notes"], { delete: true }, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(rmSyncMock).toHaveBeenCalledWith("/Users/a/notes", { recursive: true, force: true });
    expect(JSON.parse(stdout())).toMatchObject({ deleted: true });
  });

  it("errors when the folder isn't tracked and no --delete", async () => {
    removeSpaceMock.mockReturnValue(false);

    const code = await forgetCommand.run(["/Users/a/gone"], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it("still deletes an untracked folder with --delete (delete-always)", async () => {
    removeSpaceMock.mockReturnValue(false);

    const code = await forgetCommand.run(["/Users/a/loose"], { delete: true }, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(rmSyncMock).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout())).toMatchObject({ deleted: true });
  });

  it("refuses to delete the home directory (catastrophe stop)", async () => {
    removeSpaceMock.mockReturnValue(true);

    const code = await forgetCommand.run(["/Users/test"], { delete: true }, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it("refuses to delete the filesystem root", async () => {
    const code = await forgetCommand.run(["/"], { delete: true }, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(rmSyncMock).not.toHaveBeenCalled();
  });
});
