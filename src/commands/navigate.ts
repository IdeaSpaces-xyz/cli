import { initClient } from "../client.js";
import { createOutput } from "../output.js";
import { getLastSha, setLastSha } from "../auth/session-state.js";
import type { CommandDef } from "../types.js";

export const navigateCommand: CommandDef = {
  name: "navigate",
  description: "Explore the knowledge tree",
  usage: "ideaspaces navigate [path]",
  examples: [
    "ideaspaces navigate           # root",
    "ideaspaces navigate core/     # subtree",
  ],
  async run(args, _flags, global) {
    const output = createOutput(global);
    const client = await initClient(global);
    const path = args[0] ?? "";
    const { data: r } = await client.navigate(path);

    if (global.json) {
      output.result(r, "");
      return 0;
    }

    const lines: string[] = [];
    lines.push(r.path || "(root)");
    if (r.file_count > 0) lines.push(`${r.file_count} files`);
    if (r.readme) { lines.push(""); lines.push(r.readme); }
    if (r.now) { lines.push(""); lines.push(`Now: ${r.now}`); }

    const dirs = r.children.filter((c) => c.type === "directory");
    const files = r.children.filter((c) => c.type !== "directory");
    if (dirs.length) {
      lines.push("", "Directories:");
      for (const d of dirs) {
        const count = d.file_count ? ` (${d.file_count})` : "";
        const summary = d.summary ? ` — ${d.summary}` : "";
        lines.push(`  ${d.name}/${count}${summary}`);
      }
    }
    if (files.length) {
      lines.push("", "Files:");
      for (const f of files) {
        const summary = f.summary ? ` — ${f.summary}` : "";
        lines.push(`  ${f.name}${summary}`);
      }
    }

    // Session awareness — show changes since last visit
    const repoId = client.repoId;
    const lastSha = getLastSha(repoId);
    if (lastSha && path === "") {
      try {
        const { data: changes } = await client.gitOps({ op: "changes", since: lastSha });
        if (changes.changes?.length) {
          lines.push("", `Since last session (${changes.changes.length} changes):`);
          for (const ch of changes.changes.slice(0, 15)) {
            lines.push(`  ${ch.status} ${ch.path}`);
          }
          if (changes.changes.length > 15) {
            lines.push(`  ... and ${changes.changes.length - 15} more`);
          }
        }
      } catch { /* stale SHA — skip */ }
    }

    // Track HEAD for next session
    if (path === "") {
      try {
        const { data: log } = await client.gitOps({ op: "log", limit: 1 });
        const headSha = log.entries?.[0]?.sha;
        if (headSha) setLastSha(repoId, headSha);
      } catch { /* best effort */ }
    }

    // Agent context
    if (r.agent_context?.length) {
      const kinds = new Map<string, typeof r.agent_context>();
      for (const a of r.agent_context) {
        const k = a.kind || "other";
        if (!kinds.has(k)) kinds.set(k, []);
        kinds.get(k)!.push(a);
      }
      const show = (label: string, keys: string[]) => {
        const items = keys.flatMap((k) => kinds.get(k) || []);
        if (!items.length) return;
        lines.push("", `${label}:`);
        for (const a of items) {
          const desc = a.description ? ` — ${a.description}` : "";
          const from = a.inherited_from ? ` (from ${a.inherited_from})` : "";
          lines.push(`  ${a.name}${from}${desc}`);
        }
      };
      show("Direction", ["now", "purpose"]);
      show("Guidance", ["guidance", "soul", "identity", "custom"]);
      show("Perspectives", ["perspective"]);
      show("Skills", ["skill"]);
    }

    output.result(r, lines.join("\n"));
    return 0;
  },
};
