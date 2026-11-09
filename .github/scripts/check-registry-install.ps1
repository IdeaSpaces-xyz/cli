# Runs only on disposable CI runners. No credentials or model turns are needed.
$ErrorActionPreference = 'Stop'
$version = $env:RELEASE_VERSION
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Give an exact stable version, such as 0.9.1.' }
if ($env:EXPECTED_COMMIT -notmatch '^[0-9a-f]{40}$') { throw 'Expected a full source commit.' }

$source = (Get-Location).Path
$homeDir = Join-Path $env:RUNNER_TEMP ('CLI registry HOME ' + [guid]::NewGuid())
$prefix = Join-Path $env:RUNNER_TEMP ('CLI installed prefix ' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $homeDir, $prefix | Out-Null
try {
  # Never inherit an app/agent's routing, credentials or Git overrides.
  Get-ChildItem Env: | Where-Object { $_.Name -match '^(IDEASPACES_|IS_|PI_|GIT_)' } | ForEach-Object { Remove-Item ('Env:' + $_.Name) }
  $env:HOME = $homeDir
  if ($IsWindows) { $env:USERPROFILE = $homeDir }
  $env:npm_config_cache = Join-Path $homeDir 'npm-cache'
  $env:npm_config_userconfig = Join-Path $homeDir '.npmrc'
  Set-Content -Path $env:npm_config_userconfig -Value ''
  $env:IDEASPACES_NO_UPDATE_CHECK = '1'

  $metadata = & npm view "@ideaspaces/cli@$version" --json
  if ($LASTEXITCODE -ne 0) { throw 'Exact version is not visible in the public registry.' }
  $meta = ($metadata -join "`n") | ConvertFrom-Json
  if ($meta.version -ne $version -or $meta.gitHead -ne $env:EXPECTED_COMMIT) { throw 'Registry version/gitHead does not match this exact source ref.' }
  if (-not $meta.dist.integrity) { throw 'Registry response has no artifact integrity.' }

  & npm install --global --prefix $prefix --ignore-scripts --no-audit --no-fund "@ideaspaces/cli@$version"
  if ($LASTEXITCODE -ne 0) { throw 'Clean registry install failed.' }
  $packageDir = if ($IsWindows) { Join-Path $prefix 'node_modules/@ideaspaces/cli' } else { Join-Path $prefix 'lib/node_modules/@ideaspaces/cli' }
  $cli = if ($IsWindows) { Join-Path $prefix 'ideaspaces.cmd' } else { Join-Path $prefix 'bin/ideaspaces' }
  $installed = Get-Content (Join-Path $packageDir 'package.json') -Raw | ConvertFrom-Json
  if ($installed.version -ne $version) { throw 'Installed package version mismatch.' }
  if ($installed.dependencies -and @($installed.dependencies.PSObject.Properties).Count -gt 0) { throw 'Expected zero runtime dependencies.' }
  $expectedHash = (Get-FileHash (Join-Path $source 'bundle/ideaspaces.js') -Algorithm SHA256).Hash
  $actualHash = (Get-FileHash (Join-Path $packageDir 'bundle/ideaspaces.js') -Algorithm SHA256).Hash
  if ($expectedHash -ne $actualHash) { throw 'Registry bundle bytes differ from the committed source artifact.' }

  Set-Location $homeDir
  $reportedVersion = & $cli --version
  if ($LASTEXITCODE -ne 0 -or ($reportedVersion -join "`n").Trim() -ne $version) { throw 'Installed executable/shim did not report the release version.' }
  $spacesHelp = & $cli spaces --help 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Installed spaces help failed.' }
  foreach ($verb in @('list', 'open', 'new', 'add', 'remove', 'import', 'export')) {
    if (($spacesHelp -join "`n") -notmatch "\b$verb\b") { throw "Installed spaces help lacks $verb." }
  }
  $threadsHelp = & $cli threads --help 2>&1
  if ($LASTEXITCODE -ne 0 -or ($threadsHelp -join "`n") -notmatch '--home') { throw 'Installed Threads help lacks hosted Space placement.' }
  if (($threadsHelp -join "`n") -notmatch 'launch-text') { throw 'Installed Threads help lacks launch-text.' }
  Write-Output (@{ version = $version; gitHead = $meta.gitHead; integrity = $meta.dist.integrity; bundleSha256 = $actualHash.ToLowerInvariant(); node = (& node --version); nativeWindowsShim = $IsWindows; result = 'PASS' } | ConvertTo-Json -Compress)
} finally {
  Set-Location $source
  # Only directories created by this invocation, never a user's HOME or prefix.
  Remove-Item -LiteralPath $homeDir -Recurse -Force
  Remove-Item -LiteralPath $prefix -Recurse -Force
}
