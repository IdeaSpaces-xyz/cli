// Diagnostic only: rebuild both variants from the v0.7.0 plugin's CLI source.
// Never patch a bundled executable, install anything, or contact an account API.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const output = '.controlled-exit';
mkdirSync(output, { recursive: true });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const expected = '690432eccf689298eeedb7fedd9be9ba14b97994189facd05fd22dd287193c5a';
const originalBundle = execFileSync('git', ['show', 'HEAD:bundle/ideaspaces.js'], { maxBuffer: 8 * 1024 * 1024 });
if (sha(originalBundle) !== expected) throw Error('Checkout is not the v0.7.0 plugin CLI artifact');
const mainPath = 'src/main.ts';
const originalMain = readFileSync(mainPath, 'utf8');
const needle = 'process.exit(exitCode);';
if (originalMain.split(needle).length !== 3) throw Error('Expected exactly two post-command exit sites');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = () => execFileSync(npm, ['run', 'build'], { stdio: 'inherit' });
try {
  // Prove the toolchain reproduces the exact released control first.
  build();
  if (sha(readFileSync('bundle/ideaspaces.js')) !== expected) throw Error('Control rebuild differs from release');
  copyFileSync('bundle/ideaspaces.js', `${output}/forced.mjs`);
  writeFileSync(mainPath, originalMain.replaceAll(needle, 'process.exitCode = exitCode;'));
  build();
  copyFileSync('bundle/ideaspaces.js', `${output}/graceful.mjs`);
  writeFileSync(`${output}/source-change.diff`, originalMain.split('\n').flatMap((line, index) => line.includes(needle) ? [`line ${index + 1}: - ${line}`, `line ${index + 1}: + ${line.replace(needle, 'process.exitCode = exitCode;')}`] : []).join('\n') + '\n');
} finally {
  writeFileSync(mainPath, originalMain);
  mkdirSync('bundle', { recursive: true });
  writeFileSync('bundle/ideaspaces.js', originalBundle);
}
const mcpUrl = 'https://raw.githubusercontent.com/IdeaSpaces-xyz/claude-code-plugin/v0.7.0/dist/index.js';
const response = await fetch(mcpUrl);
if (!response.ok) throw Error(`MCP download: ${response.status}`);
const mcp = Buffer.from(await response.arrayBuffer());
if (sha(mcp) !== 'f0f09349718d9606a8452ade5d43b8d022138f7162700c172776868c936fd778') throw Error('MCP artifact hash mismatch');
writeFileSync(`${output}/mcp.mjs`, mcp);
writeFileSync(`${output}/manifest.json`, JSON.stringify({
  release: 'claude-code-plugin/v0.7.0',
  cliCommit: 'b28461d388960807e4241ecb755391da2e33720e',
  controlSha256: expected,
  candidateSha256: sha(readFileSync(`${output}/graceful.mjs`)),
  mcpSha256: sha(mcp),
  change: 'Only the two process.exit(exitCode) sites after command completion become process.exitCode = exitCode; help/argument exits unchanged.',
}, null, 2) + '\n');
console.log(readFileSync(`${output}/manifest.json`, 'utf8'));
