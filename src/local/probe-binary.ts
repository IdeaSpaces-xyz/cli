// Is a runtime binary runnable, and which version? Shared by `pi-status` and
// `claude-status` so the ENOENT handling and the version regex cannot drift.

import { spawnSync } from "node:child_process";

export interface ProbedBinary {
  present: boolean;
  /** What was probed — the caller's flag value, or the bare name for a PATH lookup. */
  path: string;
  version: string | null;
}

/** Run `<bin> --version` once. ENOENT, timeout, or non-zero exit → absent. The
 * same spawn resolution a turn uses, so detection and the send path agree. */
export function probeBinary(bin: string, env: NodeJS.ProcessEnv = process.env): ProbedBinary {
  try {
    const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, env });
    if (res.error || res.status !== 0) return { present: false, path: bin, version: null };
    const m = /\d+\.\d+\.\d+[\w.-]*/.exec(res.stdout ?? "");
    return { present: true, path: bin, version: m ? m[0] : null };
  } catch {
    return { present: false, path: bin, version: null };
  }
}
