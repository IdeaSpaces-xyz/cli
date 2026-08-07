import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  inspectMarkdownFile,
  type MarkdownHeading,
  type MarkdownInspection,
  type MarkdownInspectionMode,
  type MarkdownInspectionRequest,
} from "@ideaspaces/protocol";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const USAGE = "ideaspaces inspect <path> [--mode summary|outline|section] [--heading <text>] [--occurrence <n>] [--max-bytes <n>] [--json]";
const DEFAULT_MAX_BYTES = 50 * 1024;
const MAX_MAX_BYTES = 1024 * 1024;
const MIN_MAX_BYTES = 128;

interface Truncation {
  truncated: boolean;
  originalBytes: number;
  returnedBytes: number;
  limitBytes: number;
}

interface BoundedInspection {
  inspection: MarkdownInspection;
  truncation: Truncation;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Return an exact UTF-8 prefix without splitting a code point. */
function utf8Prefix(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function stringTruncation(value: string, returned: string, limitBytes: number): Truncation {
  const originalBytes = byteLength(value);
  const returnedBytes = byteLength(returned);
  return {
    truncated: returnedBytes < originalBytes,
    originalBytes,
    returnedBytes,
    limitBytes,
  };
}

/**
 * Bound the inspection payload while preserving its protocol shape. Outline
 * truncation keeps a complete prefix of heading records; strings keep an exact
 * UTF-8 prefix. Metadata makes every omitted byte explicit.
 */
export function boundInspection(
  inspection: MarkdownInspection,
  limitBytes: number,
): BoundedInspection {
  if (inspection.mode === "summary") {
    if (inspection.summary === null) {
      return {
        inspection,
        truncation: {
          truncated: false,
          originalBytes: 0,
          returnedBytes: 0,
          limitBytes,
        },
      };
    }
    const summary = utf8Prefix(inspection.summary, limitBytes);
    return {
      inspection: { ...inspection, summary },
      truncation: stringTruncation(inspection.summary, summary, limitBytes),
    };
  }

  if (inspection.mode === "outline") {
    const originalBytes = byteLength(JSON.stringify(inspection.headings));
    if (originalBytes <= limitBytes) {
      return {
        inspection,
        truncation: {
          truncated: false,
          originalBytes,
          returnedBytes: originalBytes,
          limitBytes,
        },
      };
    }

    const headings: MarkdownHeading[] = [];
    for (const heading of inspection.headings) {
      const candidate = [...headings, heading];
      if (byteLength(JSON.stringify(candidate)) > limitBytes) break;
      headings.push(heading);
    }
    const returnedBytes = byteLength(JSON.stringify(headings));
    return {
      inspection: { mode: "outline", headings },
      truncation: {
        truncated: true,
        originalBytes,
        returnedBytes,
        limitBytes,
      },
    };
  }

  if (inspection.status !== "found") {
    const payload = JSON.stringify(inspection.matches);
    const bytes = byteLength(payload);
    // Match lists are heading outlines too. Reuse the same complete-record
    // prefix behavior so pathological duplicate sets cannot bypass the bound.
    if (bytes > limitBytes) {
      const bounded = boundInspection(
        { mode: "outline", headings: inspection.matches },
        limitBytes,
      );
      return {
        inspection: { ...inspection, matches: bounded.inspection.mode === "outline" ? bounded.inspection.headings : [] },
        truncation: bounded.truncation,
      };
    }
    return {
      inspection,
      truncation: {
        truncated: false,
        originalBytes: bytes,
        returnedBytes: bytes,
        limitBytes,
      },
    };
  }

  const markdown = utf8Prefix(inspection.markdown, limitBytes);
  return {
    inspection: { ...inspection, markdown },
    truncation: stringTruncation(inspection.markdown, markdown, limitBytes),
  };
}

function parseMode(raw: string | boolean | undefined): MarkdownInspectionMode | null {
  if (raw === undefined) return "summary";
  if (raw === "summary" || raw === "outline" || raw === "section") return raw;
  return null;
}

function parsePositiveInteger(raw: string | boolean | undefined): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requestFor(
  mode: MarkdownInspectionMode,
  flags: Record<string, string | boolean>,
): { request?: MarkdownInspectionRequest; error?: string } {
  const heading = flags.heading;
  const occurrence = flags.occurrence;

  if (mode !== "section") {
    if (heading !== undefined || occurrence !== undefined) {
      return { error: "--heading and --occurrence require --mode section" };
    }
    return { request: { mode } };
  }

  if (typeof heading !== "string" || !heading.trim()) {
    return { error: "--mode section requires --heading <text>" };
  }
  if (occurrence === undefined) {
    return { request: { mode: "section", heading } };
  }
  const parsed = parsePositiveInteger(occurrence);
  if (parsed === null) {
    return { error: "--occurrence must be a positive integer" };
  }
  return { request: { mode: "section", heading, occurrence: parsed } };
}

function formatHeading(heading: MarkdownHeading): string {
  const duplicate = heading.occurrence > 1 ? `, occurrence ${heading.occurrence}` : "";
  return `${"#".repeat(heading.level)} ${heading.text} (line ${heading.line}${duplicate})`;
}

function formatHuman(inspection: MarkdownInspection, truncation: Truncation): string {
  let text: string;
  if (inspection.mode === "summary") {
    text = inspection.summary ?? "(no summary)";
  } else if (inspection.mode === "outline") {
    text = inspection.headings.length
      ? inspection.headings.map(formatHeading).join("\n")
      : "(no headings)";
  } else if (inspection.status === "found") {
    text = inspection.markdown;
  } else {
    const label = inspection.status === "ambiguous" ? "Ambiguous heading" : "Heading not found";
    const matches = inspection.matches.length
      ? `\n${inspection.matches.map(formatHeading).join("\n")}`
      : "";
    text = `${label}: ${inspection.query.heading}${matches}`;
  }

  if (!truncation.truncated) return text;
  const notice = `[truncated: returned ${truncation.returnedBytes} of ${truncation.originalBytes} inspection bytes; --max-bytes accepts ${MIN_MAX_BYTES}..${MAX_MAX_BYTES}]`;
  return text ? `${text}\n\n${notice}` : notice;
}

export const inspectCommand: CommandDef = {
  name: "inspect",
  description: "Inspect a local Markdown file progressively (summary, outline, or one section)",
  usage: USAGE,
  examples: [
    "ideaspaces inspect work/Next.md",
    "ideaspaces inspect work/Next.md --mode outline",
    'ideaspaces inspect work/Next.md --mode section --heading "Current priority"',
    'ideaspaces inspect work/Next.md --mode section --heading "Review" --occurrence 2 --json',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const rawPath = args[0];
    if (!rawPath || args.length !== 1) {
      output.error(`Usage: ${USAGE}`);
      return 1;
    }

    const mode = parseMode(flags.mode);
    if (!mode) {
      output.error("--mode must be summary, outline, or section");
      return 1;
    }
    const requested = requestFor(mode, flags);
    if (!requested.request) {
      output.error(requested.error ?? `Usage: ${USAGE}`);
      return 1;
    }

    let maxBytes = DEFAULT_MAX_BYTES;
    if (flags["max-bytes"] !== undefined) {
      const parsed = parsePositiveInteger(flags["max-bytes"]);
      if (parsed === null || parsed < MIN_MAX_BYTES || parsed > MAX_MAX_BYTES) {
        output.error(`--max-bytes must be an integer from ${MIN_MAX_BYTES} to ${MAX_MAX_BYTES}`);
        return 1;
      }
      maxBytes = parsed;
    }

    const path = resolve(rawPath);
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        output.error(`Not a file: ${path}`);
        return 1;
      }
      const inspected = await inspectMarkdownFile(path, requested.request);
      const bounded = boundInspection(inspected, maxBytes);
      const data = { path, ...bounded.inspection, truncation: bounded.truncation };
      output.result(data, formatHuman(bounded.inspection, bounded.truncation));
      return bounded.inspection.mode === "section" && bounded.inspection.status !== "found" ? 1 : 0;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") output.error(`No such file: ${path}`);
      else output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  },
};
