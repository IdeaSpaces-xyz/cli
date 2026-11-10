import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const expected = ["LICENSE", "README.md", "bundle/agent-tools.json", "bundle/agent-tools.schema.json", "bundle/ideaspaces.js", "package.json"];
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
  // Explicitly requested help is primary output; errors remain on stderr.
  if (result.stderr || !result.stdout.includes("Usage: ideaspaces <command> [options]") || !result.stdout.includes("look")) {
    throw new Error("Installed CLI did not render the expected help output.");
  }

  // The app and the plugin carry the bundle alone: the version has to be inside it.
  const version = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (version.error) throw version.error;
  if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
    throw new Error(`Installed CLI reported "${version.stdout.trim()}" for --version, expected ${pkg.version}.`);
  }

  // Progressive discovery works without auth, from an unrelated cwd, through the installed executable.
  const artifact = JSON.parse(readFileSync(new URL("../bundle/agent-tools.json", import.meta.url), "utf8"));
  for (const selector of [undefined, "threads", "threads.post"]) {
    const result = spawnSync(executablePath, ["capabilities", ...(selector ? [selector] : []), "--json"], {
      cwd: temp, encoding: "utf8", shell: process.platform === "win32",
      env: { ...process.env, IDEASPACES_AUTH: "host", IDEASPACES_NO_UPDATE_CHECK: "1" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.stderr) throw new Error(`Installed capabilities failed: ${result.stderr}`);
    const data = JSON.parse(result.stdout);
    if (data.digest !== artifact.digest || data.cli.version !== pkg.version || data.protocol.commit !== artifact.protocol.commit) throw new Error("Installed catalog provenance differs from the shipped artifact");
    if (!selector && (data.groups.length !== 14 || data.entries !== undefined)) throw new Error("Discovery root leaked entry details");
    if (selector === "threads" && (!data.entries.some(e => e.id === "threads.post") || data.entries.some(e => e.parameters || e.check))) throw new Error("Group discovery must contain brief entries only");
    if (selector === "threads.post" && (!data.entry.parameters.properties.reply_to || !data.entry.text.check || !data.entry.text.bound)) throw new Error("Full entry contract is incomplete");
  }

  const standalone = join(temp, "standalone.mjs");
  copyFileSync(new URL("../bundle/ideaspaces.js", import.meta.url), standalone);
  const alone = spawnSync(process.execPath, [standalone, "capabilities", "threads.post", "--json"], { cwd: temp, encoding: "utf8" });
  if (alone.error) throw alone.error;
  if (alone.status !== 0 || JSON.parse(alone.stdout).digest !== artifact.digest) throw new Error("Single-file CLI needs an adjacent catalog");
  // A typo must fail before an account write, network call, or version result.
  for (const args of [["pi-login", "--provider=fixture", "--api-key=not-a-real-key"], ["clone"], ["--version"]]) {
    const refused = spawnSync(process.execPath, [standalone, ...args, "--catalog-typo", "--json"], {
      cwd: temp, encoding: "utf8", env: { ...process.env, HOME: temp, USERPROFILE: temp, IDEASPACES_AUTH: "host" },
    });
    if (refused.error) throw refused.error;
    if (refused.status !== 1 || !refused.stderr.includes("--catalog-typo")) throw new Error(`Undeclared flag reached ${args[0]}`);
  }

  // `status <section>` is the canonical spelling; its --help must reach the section.
  const sectionHelp = spawnSync(executablePath, ["status", "account", "--help"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (sectionHelp.error) throw sectionHelp.error;
  if (sectionHelp.status !== 0 || sectionHelp.stderr || !sectionHelp.stdout.includes("Usage: ideaspaces status account")) {
    throw new Error("Installed CLI did not route `status account --help` to the section.");
  }

  const verbHelp = spawnSync(executablePath, ["threads", "open", "--help"], {
    encoding: "utf8", shell: process.platform === "win32",
  });
  if (verbHelp.error) throw verbHelp.error;
  if (verbHelp.status !== 0 || verbHelp.stderr ||
      !verbHelp.stdout.includes("Usage: ideaspaces threads open <slug|path>") ||
      verbHelp.stdout.includes("ideaspaces threads post <slug|path>")) {
    throw new Error("Installed CLI did not render threads open's own help on stdout.");
  }
  const unknownVerb = spawnSync(executablePath, ["threads", "not-a-verb", "--help"], {
    encoding: "utf8", shell: process.platform === "win32",
  });
  if (unknownVerb.error) throw unknownVerb.error;
  if (unknownVerb.status !== 1 || unknownVerb.stdout ||
      !unknownVerb.stderr.includes("Unknown threads subcommand")) {
    throw new Error("Installed CLI treated an unknown Threads verb as supported.");
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
