import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "ideaspaces-cli-package-"));

try {
  if (Object.keys(pkg.dependencies ?? {}).length !== 0) {
    throw new Error("The published CLI must have zero runtime dependencies; bundle them at build time.");
  }
  if (pkg.bin?.ideaspaces !== "bundle/ideaspaces.js") {
    throw new Error("package.json must expose bundle/ideaspaces.js as the ideaspaces executable.");
  }

  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
      { cwd: root, encoding: "utf8" },
    ),
  )[0];

  const paths = packed.files.map((file) => file.path).sort();
  const expected = ["LICENSE", "README.md", "bundle/ideaspaces.js", "package.json"];
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected package contents.\nExpected: ${expected.join(", ")}\nActual:   ${paths.join(", ")}`,
    );
  }
  const executable = packed.files.find((file) => file.path === "bundle/ideaspaces.js");
  if (!executable || (executable.mode & 0o111) === 0) {
    throw new Error("The published CLI entrypoint must be executable.");
  }

  const tarball = join(temp, packed.filename);
  const installRoot = join(temp, "install");
  execFileSync(
    "npm",
    ["install", "--global", "--no-audit", "--no-fund", "--prefix", installRoot, tarball],
    { stdio: "inherit" },
  );

  const executablePath =
    process.platform === "win32"
      ? join(installRoot, "ideaspaces.cmd")
      : join(installRoot, "bin", "ideaspaces");
  const result = spawnSync(executablePath, ["--help"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `Installed CLI exited ${result.status}`);
  }
  // Human-readable CLI output goes to stderr so --json can reserve stdout.
  if (!result.stderr.includes("Usage: ideaspaces <command> [options]")) {
    throw new Error("Installed CLI did not render the expected help output.");
  }

  console.log(
    `Verified ${pkg.name}@${pkg.version}: ${packed.files.length} files, ` +
      `${packed.unpackedSize} bytes unpacked, zero runtime dependencies, installed CLI runs.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
