// A loopback IdeaSpaces for publish-host.test.ts, in its own process: the CLI pushes with spawnSync, which would block a
// server in the test's own event loop. The API answers /auth/me and POST /api/v1/repos; /repos/<id>.git is a real
// `git http-backend`. Every request is logged as one JSON line to the log file. argv: <root> <log> <mode>: "200" creates,
// another status refuses POST /repos with it ("409" as for a repository already there), "nopush" refuses every push.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [root, log, createStatus = "200"] = process.argv.slice(2);
const served = join(root, "served");
mkdirSync(join(served, "repos"), { recursive: true });

function backend(req, res, url) {
  const child = spawn("git", ["http-backend"], { env: { PATH: process.env.PATH, GIT_EXEC_PATH: process.env.GIT_EXEC_PATH ?? "", GIT_PROJECT_ROOT: served, GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
    HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""), REMOTE_USER: "anna", REMOTE_ADDR: "127.0.0.1" } });
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  req.pipe(child.stdin);
  child.on("close", () => {
    const out = Buffer.concat(chunks);
    const split = out.indexOf("\r\n\r\n");
    let status = 200;
    for (const line of out.subarray(0, split).toString("utf8").split("\r\n")) {
      const at = line.indexOf(":");
      const key = line.slice(0, at), value = line.slice(at + 1).trim();
      if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else if (key) res.setHeader(key, value);
    }
    res.statusCode = status;
    res.end(out.subarray(split + 4));
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  appendFileSync(log, `${JSON.stringify({ method: req.method, path: url.pathname, auth: req.headers.authorization ?? null })}\n`);
  if (url.pathname.startsWith("/repos/")) {
    if (createStatus === "nopush" && (url.search.includes("git-receive-pack") || url.pathname.endsWith("/git-receive-pack"))) { res.statusCode = 403; return res.end("no"); }
    return backend(req, res, url);
  }
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/auth/me") return res.end(JSON.stringify({ user_id: 1, username: "anna", name: "Anna Bērziņa", email: "anna@example.com", repos: [], onboarding_complete: true }));
  if (url.pathname === "/api/v1/repos" && req.method === "POST") {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (createStatus !== "200" && createStatus !== "nopush") {
        res.statusCode = Number(createStatus);
        return res.end(JSON.stringify({ detail: { code: "publishing_subscription_required" } }));
      }
      const id = body.root_node_id ?? `n_${"b".repeat(24)}`;
      spawnSync("git", ["init", "-q", "--bare", "-b", "main", join(served, "repos", `${id}.git`)]);
      res.end(JSON.stringify({ repo_id: "repo_000000000001", root_node_id: id, slug: "research", name: body.name }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
