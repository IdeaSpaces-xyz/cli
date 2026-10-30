import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface CliProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Real bundled entry, with no ambient account, proxy, runtime, or Git config. */
export function cliEnvironment(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(IS_|IDEASPACES_|CLAUDE|PI_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_USE_ENV_PROXY$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|GIT_)/i.test(key)) delete env[key];
  }
  return {
    ...env, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: resolve(home, ".claude"),
    GIT_CONFIG_GLOBAL: resolve(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  };
}

export function runCli(
  args: string[],
  options: { home: string; env?: NodeJS.ProcessEnv; stdin?: string; preload?: string; timeoutMs?: number },
): Promise<CliProcessResult> {
  const entry = resolve("bundle/ideaspaces.js");
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [
      ...(options.preload ? ["--import", options.preload] : []), entry, ...args,
    ], { cwd: options.home, env: { ...cliEnvironment(options.home), ...options.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 12_000);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    // A command that does not read stdin can finish before the pipe is written.
    child.stdin.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, timedOut, stdout, stderr }); });
    child.stdin.end(options.stdin);
  });
}
