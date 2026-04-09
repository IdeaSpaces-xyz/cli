import { SdkError } from "@ideaspaces/sdk";
import type { Output } from "./output.js";

const EXIT_CODES: Record<string, number> = {
  auth_error: 3,
  not_found: 4,
  client_error: 5,
  rate_limited: 6,
  overloaded: 7,
  network_error: 8,
  timeout: 9,
};

const HINTS: Record<string, string> = {
  auth_error: "Run: ideaspaces login",
  not_found: "Check the path with: ideaspaces navigate",
  rate_limited: "Wait a moment and retry.",
  overloaded: "Server is busy. Try again in a moment.",
  network_error: "Check your internet connection.",
  timeout: "Request timed out. Try again.",
};

export function handleError(err: unknown, output: Output): number {
  if (err instanceof SdkError) {
    const hint = HINTS[err.category] ?? "";
    output.error(`Error: ${err.message}${hint ? `\n${hint}` : ""}`);
    return EXIT_CODES[err.category] ?? 1;
  }

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
