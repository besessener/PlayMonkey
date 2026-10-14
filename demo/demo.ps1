# Runs the local demo: starts the fixture site (unless one is already running on the port) and lets the monkey loose
# on the demo shop with demo.json next to this script. Usage, from anywhere: .\demo\demo.ps1 [-Port 8080] [-SlowMo 600]
param(
  [int]$Port = 8080,
  [int]$SlowMo = 600
)
$ErrorActionPreference = "Stop"

# User-scope variables set with SetEnvironmentVariable are not visible in terminals opened before.
$required = [ordered]@{
  MONKEY_LLM_URL        = "LLM endpoint"
  MONKEY_LLM_API_KEY    = "LLM API key"
  MONKEY_LLM_DEPLOYMENT = "LLM deployment"
}
$missing = @()
foreach ($name in $required.Keys) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) { $value = [Environment]::GetEnvironmentVariable($name, "User") }
  if ([string]::IsNullOrWhiteSpace($value)) { $missing += "  $name ($($required[$name]))" }
  else { Set-Item "env:$name" $value }
}
if ($missing.Count -gt 0) {
  [Console]::Error.WriteLine("The demo needs an LLM, but these environment variables are not set:")
  foreach ($line in $missing) { [Console]::Error.WriteLine($line) }
  [Console]::Error.WriteLine("Set them in this session or your user profile; see docs/how-to/llm-einrichten.md")
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$config = Join-Path $PSScriptRoot "demo.json"
Set-Location $root

$env:FIXTURE_URL = "http://127.0.0.1:$Port"

function Test-Site { try { $null = Invoke-WebRequest "$env:FIXTURE_URL/demo" -UseBasicParsing -TimeoutSec 2; $true } catch { $false } }

$site = $null
if (-not (Test-Site)) {
  $env:PORT = "$Port"
  $site = Start-Process node -ArgumentList "fixtures/site/start.ts" -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Site)) {
    if ($site.HasExited -or (Get-Date) -gt $deadline) { throw "the fixture site did not start on port $Port" }
    Start-Sleep -Milliseconds 200
  }
}

try {
  Write-Host "Demo shop at $env:FIXTURE_URL/demo"
  npx monkey run $config --slow-mo $SlowMo
} finally {
  if ($null -ne $site -and -not $site.HasExited) { Stop-Process -Id $site.Id }
}
