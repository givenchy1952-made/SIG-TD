[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Review','Backup','Decrypt','Full')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$EnvironmentFile,
  [string]$BackupFile,
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) { throw '비공개 환경 설정 파일을 확인하세요.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 이상을 설치하고 PowerShell을 다시 여세요.' }
$major = [int]((& node -p 'process.versions.node.split(".")[0]') | Select-Object -Last 1)
if ($major -lt 22) { throw 'Node.js 22 이상이 필요합니다.' }
$environmentPath = (Resolve-Path -LiteralPath $EnvironmentFile).Path
$tool = Join-Path $PSScriptRoot 'backup-di.mjs'
$arguments = @("--env-file=$environmentPath", $tool)
switch ($Mode) {
  'Review' { $arguments += 'review' }
  'Backup' { $arguments += 'backup' }
  'Full' { $arguments = @("--env-file=$environmentPath", (Join-Path $PSScriptRoot 'backup-workspace.mjs')) }
  'Decrypt' {
    if (-not $BackupFile -or -not $OutputDirectory) { throw 'Decrypt에는 -BackupFile 및 새 -OutputDirectory가 필요합니다.' }
    $arguments += @('decrypt', $BackupFile, $OutputDirectory)
  }
}
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "백업 도구가 실패했습니다 (exit $LASTEXITCODE). 출력된 오류를 확인하세요." }
