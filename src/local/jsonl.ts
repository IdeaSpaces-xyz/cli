/** Strict LF-only JSONL framing, shared by every local runtime that speaks
 * JSON-lines over a pipe (pi RPC, Claude Code stream-json). Unicode
 * U+2028/U+2029 are valid inside JSON strings and must not be treated as
 * record separators. */

import { StringDecoder } from "node:string_decoder";

export async function* readJsonLines(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += decoder.write(Buffer.from(chunk));
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
    }
  }
  buffer += decoder.end();
  if (buffer) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
}
