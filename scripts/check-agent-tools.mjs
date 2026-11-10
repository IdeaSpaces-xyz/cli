// Drift is a build failure, not an extra flag silently ignored by a command.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { entries } from "../dist/agent-tools/data.js";

export function checkSourceFlags(readSource = path => readFileSync(path, "utf8")) {
  const files = {
    look: "commands/look.ts", navigate: "commands/navigate.ts", inspect: "commands/inspect.ts",
    ls: "commands/ls.ts", times: "commands/times.ts", write: "commands/write.ts", commit: "commands/commit.ts",
    map: "commands/map.ts", "map-edit": "commands/map-edit.ts", "map-selection": "commands/map-selection.ts",
    threads: "commands/threads.ts", "hosted-threads": "commands/hosted-threads.ts", skills: "commands/skills.ts", node: "commands/node.ts",
    spaces: "commands/spaces.ts", "space-new": "commands/hosted-space-new.ts", "space-add": "commands/hosted-space-writes.ts", "space-remove": "commands/hosted-space-remove.ts",
    vaults: "commands/vaults.ts", get: "commands/get.ts", clone: "commands/clone.ts", fork: "commands/fork.ts", link: "commands/link.ts", forget: "commands/forget.ts",
    clones: "commands/clones.ts", integrate: "commands/integrate.ts", update: "commands/update.ts", pull: "commands/pull.ts", push: "commands/push.ts", sync: "commands/sync.ts",
    catalog: "commands/catalog.ts", repos: "commands/repos.ts", publish: "commands/publish.ts", status: "commands/status.ts", share: "commands/share.ts", request: "commands/request.ts",
    agent: "commands/agent.ts", conversation: "commands/conversation.ts", conversations: "commands/conversations.ts", agents: "commands/agents.ts", change: "commands/change.ts",
    login: "commands/login.ts", logout: "commands/power/logout.ts", whoami: "commands/whoami.ts", doctor: "commands/doctor.ts", upgrade: "commands/upgrade.ts", create: "commands/create.ts", search: "commands/search.ts",
    "pi-status": "pi/pi-status.ts", "pi-models": "pi/pi-models.ts", "pi-login": "pi/pi-login.ts", "pi-logout": "pi/pi-logout.ts", "claude-status": "claude/claude-status.ts", "claude-models": "claude/claude-models.ts",
  };
  const routing = { "map-edit": "map", "map-selection": "map", "hosted-threads": "threads", "space-new": "spaces", "space-add": "spaces", "space-remove": "spaces" };
  // These reads exist only to print explicit compatibility refusals, not accepted options.
  const refused = { fork: ["location", "slug"], publish: ["force"], conversation: ["topic"] };
  const errors = [];
  for (const [key, file] of Object.entries(files)) {
    const command = routing[key] ?? key;
    const accepted = new Set(entries.filter(e => e.cli?.argv[0] === command).flatMap(e => Object.values(e.cli.flags).flatMap(f => [f.flag.replace(/^--/, ""), ...(f.aliases ?? []).map(a => a.replace(/^-+/, ""))])));
    for (const flag of refused[command] ?? []) accepted.add(flag);
    const source = ts.createSourceFile(file, readSource(`src/${file}`), ts.ScriptTarget.Latest, true);
    function visit(node) {
      let name;
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "flags") name = node.name.text;
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "flags" && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) name = node.argumentExpression.text;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["str", "flagString", "flagStr", "value"].includes(node.expression.text) && node.arguments[0] && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === "flags" && node.arguments[1] && ts.isStringLiteral(node.arguments[1])) name = node.arguments[1].text;
      if (name && !accepted.has(name)) errors.push(`${file}: --${name} is read but not catalogued`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  if (errors.length) throw new Error([...new Set(errors)].join("\n"));
}
