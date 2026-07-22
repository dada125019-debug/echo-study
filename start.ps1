$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = 'C:\Users\Junda Mou\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'

if ($nodeCommand) {
  $nodeExecutable = $nodeCommand.Source
} elseif (Test-Path $bundledNode) {
  $nodeExecutable = $bundledNode
} else {
  Write-Error '没有找到 Node.js 18 或更高版本。请先安装 Node.js。'
  exit 1
}

Write-Host '正在启动 Echo Study：http://127.0.0.1:4173'
& $nodeExecutable (Join-Path $PSScriptRoot 'server.js')
