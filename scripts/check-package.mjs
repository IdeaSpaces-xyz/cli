import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "ideaspaces-cli-package-"));

function runNpm(args, options) {
  const npmEntrypoint = process.env.npm_execpath;
  return npmEntrypoint
    ? execFileSync(process.execPath, [npmEntrypoint, ...args], options)
    : execFileSync("npm", args, options);
}

try {
  if (Object.keys(pkg.dependencies ?? {}).length !== 0) {
    throw new Error("The published CLI must have zero runtime dependencies; bundle them at build time.");
  }
  if (pkg.bin?.ideaspaces !== "bundle/ideaspaces.js") {
    throw new Error("package.json must expose bundle/ideaspaces.js as the ideaspaces executable.");
  }

  const packed = JSON.parse(
    runNpm(
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
  if (!executable || (process.platform !== "win32" && (executable.mode & 0o111) === 0)) {
    throw new Error("The published CLI entrypoint must be executable on POSIX hosts.");
  }

  const tarball = join(temp, packed.filename);
  const installRoot = join(temp, "install");
  runNpm(
    ["install", "--global", "--no-audit", "--no-fund", "--prefix", installRoot, tarball],
    { stdio: "inherit" },
  );

  const executablePath =
    process.platform === "win32"
      ? join(installRoot, "ideaspaces.cmd")
      : join(installRoot, "bin", "ideaspaces");
  const result = spawnSync(executablePath, ["--help"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `Installed CLI exited ${result.status}`);
  }
  // Human-readable CLI output goes to stderr so --json can reserve stdout.
  if (!result.stderr.includes("Usage: ideaspaces <command> [options]") || !result.stderr.includes("look")) {
    throw new Error("Installed CLI did not render the expected help output.");
  }

  // `status <section>` is the canonical spelling; its --help must reach the section.
  const sectionHelp = spawnSync(executablePath, ["status", "account", "--help"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (sectionHelp.error) throw sectionHelp.error;
  if (sectionHelp.status !== 0 || !sectionHelp.stderr.includes("Usage: ideaspaces status account")) {
    throw new Error("Installed CLI did not route `status account --help` to the section.");
  }

  const lookRoot = join(temp, "look-fixture");
  mkdirSync(join(lookRoot, "_agent"), { recursive: true });
  writeFileSync(join(lookRoot, "_agent", "agreement.md"), "# Agreement\n\nREFERENCE TERMS\n");
  writeFileSync(
    join(lookRoot, "note.md"),
    "---\nname: Installed Note\nsummary: Packed look proof.\n---\n# Installed Note\n\n## Evidence\n",
  );
  const looked = spawnSync(
    executablePath,
    ["look", "note.md", "--depth", "children", "--json"],
    { cwd: lookRoot, encoding: "utf8", shell: process.platform === "win32" },
  );
  if (looked.error) throw looked.error;
  if (looked.status !== 0) {
    throw new Error(looked.stderr || `Installed look exited ${looked.status}`);
  }
  const lookData = JSON.parse(looked.stdout);
  if (
    lookData?.kind !== "content-look" ||
    lookData?.reference?.contractRole !== "reference" ||
    lookData?.target?.children?.[1]?.name !== "Evidence" ||
    lookData?.map !== undefined
  ) {
    throw new Error("Installed CLI did not preserve Content-look semantics");
  }

  console.log(
    `Verified ${pkg.name}@${pkg.version}: ${packed.files.length} files, ` +
      `${packed.unpackedSize} bytes unpacked, zero runtime dependencies, installed CLI runs.`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
