/** Shared test helpers for capturing command output. */

/** Monkeypatches process.stdout.write for the duration of `fn`; restores on exit. */
export async function captureStdout(
  fn: () => Promise<number>,
): Promise<{ exit: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await fn();
    return { exit, out: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

/** As `captureStdout`, but parses the captured stdout as JSON (`--json` mode). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function captureJson<T = any>(
  fn: () => Promise<number>,
): Promise<{ exit: number; json: T }> {
  const { exit, out } = await captureStdout(fn);
  return { exit, json: JSON.parse(out) as T };
}
