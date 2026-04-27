import type { Output } from "./output.js";

export function handleError(err: unknown, output: Output): number {
  if (err instanceof Error) {
    if (err.message.includes("Not logged in")) {
      output.error(`Error: ${err.message}\nRun: ideaspaces login`);
      return 2;
    }
    output.error(`Error: ${err.message}`);
    return 1;
  }

  output.error(`Error: ${String(err)}`);
  return 1;
}
