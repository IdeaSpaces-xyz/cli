/**
 * Words a local writer chose, put on one line.
 *
 * An author, a mark and a name in a post file are whatever the writer typed, and a reader prints them
 * into text an agent reads. A newline in one would let it forge the line that follows, so each is
 * reduced to a single line first: line breaks and control characters become one space. The label
 * "claimed by" says what the name is; this keeps it from lying about where the line ends.
 */

const LINE_BREAKS_AND_CONTROLS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/** The text on one line, trimmed, and cut at `max` characters with an ellipsis. */
export function oneLine(value: unknown, max = 120): string {
  const text = typeof value === "string" ? value.replace(LINE_BREAKS_AND_CONTROLS, " ").replace(/ {2,}/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `claimed by X` for a local author, or `no author claimed`. */
export function claimedBy(author: unknown): string {
  const name = oneLine(author);
  return name ? `claimed by ${name}` : "no author claimed";
}

/** A folded mark as text: `done (claimed by Scout)`. A mark is a decision signal, so its author is a claim too. */
export function markText(mark: { mark: string; author?: string }): string {
  return `${oneLine(mark.mark, 60)} (${claimedBy(mark.author)})`;
}
