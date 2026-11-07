import { closeSync, openSync, readSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import readCmdShim from "read-cmd-shim";

export interface RuntimeCommand { command: string; args: string[] }

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Match Node's case-insensitive Windows environment de-duplication order.
  const key = Object.keys(env).sort().find(key => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** PATH/PATHEXT lookup in the child's environment, not a shell or `where.exe`.
 * Do not pick npm's extensionless POSIX wrapper ahead of its Windows shim. */
function windowsExecutable(bin: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const suffixes = extname(bin) ? [""] : (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";");
  const locations = isAbsolute(bin) || /[/\\]/.test(bin)
    ? [resolve(cwd, bin)]
    : (envValue(env, "PATH") ?? "").split(";").filter(Boolean).map(dir => resolve(cwd, dir.replace(/^"|"$/g, ""), bin));
  for (const location of locations) for (const suffix of suffixes) {
    const candidate = location + suffix;
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve npm's Windows Node/native shims without evaluating command text.
 * The target is read with npm's own shim reader. Node entrypoints use a literal
 * argv array, so prompts, paths, quotes, percent signs and newlines never enter
 * cmd.exe. Non-npm/custom batch programs retain their previous spawn behavior.
 * POSIX and native executables are unchanged. Shared by probes and turns. */
export function runtimeCommand(
  bin: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(),
): RuntimeCommand {
  const original = { command: bin, args: [...args] };
  if (process.platform !== "win32") return original;
  const executable = windowsExecutable(bin, env, cwd);
  if (!executable || extname(executable).toLowerCase() !== ".cmd") return original;
  try {
    // Windows paths are case insensitive; read-cmd-shim's extension check is not.
    const shim = executable.slice(0, -4) + ".cmd";
    const target = resolve(dirname(shim), readCmdShim.sync(shim));
    if (!isFile(target)) return original;
    if (extname(target).toLowerCase() === ".exe") return { command: target, args: [...args] };
    const fd = openSync(target, "r");
    let firstLine: string;
    try {
      const header = Buffer.alloc(512);
      const length = readSync(fd, header, 0, header.length, 0);
      firstLine = header.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0];
    } finally { closeSync(fd); }
    if (!/^#!\s*(?:\/usr\/bin\/env\s+)?node(?:\.exe)?\s*$/.test(firstLine)) return original;
    const localNode = join(dirname(shim), "node.exe");
    return { command: isFile(localNode) ? localNode : process.execPath, args: [target, ...args] };
  } catch {
    // A broken/non-npm shim is not made executable by guessing or a shell fallback.
    return original;
  }
}
