# deskpet-guard — 桌面桌宠窗口（Windows / WinForms，零依赖）
#
# 这个文件必须保存为 **UTF-8 with BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会把
# 中文按 ANSI 解析成乱码。test/pet.test.mjs 有一条断言专门守这个 BOM，别把它去掉。
#
# 用法（一般由 lib/pet.js 拉起，也可以手动跑）：
#   powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File bin/deskpet-guard-pet.ps1 -DataDir <数据目录>
#   powershell.exe ... -File bin/deskpet-guard-pet.ps1 -Probe        # 不开窗口，打印文本状态
#
# 只读：只读 guard-status.json / guard-events.jsonl；唯一会写的文件是自己的锁（退出时清理）。
#
# 生命周期：-WatchPid / -WatchProcess 指定"看护对象"（客户端主进程）。
# 客户端退出 → 看护对象消失 → 桌宠自己关掉并清锁。不给看护对象则一直留着（手动启动的场景）。

param(
  [string]$DataDir = (Join-Path $env:USERPROFILE ".dsh\super-injector\deskpet-guard"),
  [int]$IntervalMs = 3000,
  [string]$Client = 'manual',
  [int]$Slot = 5,
  [int]$WatchPid = 0,
  [string]$WatchProcess = '',
  [switch]$Probe
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-GuardState {
  param([string]$Dir)
  $state = [ordered]@{
    mood = 'unknown'; headline = ''; cycles = 0; atMs = 0
    agents = 0; egress = 0; bundles = 0; alerts = 0; targets = 0
    probeErrors = @(); lastEvent = ''
    mineProcs = 0; mineEgress = 0; mineBundles = 0; mineAlerts = 0; mineTargets = 0; unAlerts = 0
    machProcs = 0; machEgress = 0; machBundles = 0; scoped = $false
  }
  $statusPath = Join-Path $Dir 'guard-status.json'
  if (Test-Path $statusPath) {
    try {
      $j = Get-Content -Raw -Encoding UTF8 $statusPath | ConvertFrom-Json
      $state.mood = [string]$j.mood
      $state.headline = [string]$j.headline
      $state.cycles = [int]$j.cycles
      $state.atMs = [long]$j.atMs
      $state.agents = [int]$j.agentProcessCount
      $state.egress = [int]$j.egressConnections
      $state.bundles = [int]$j.bundleArtifacts
      $state.alerts = [int]$j.activeFindings
      if ($j.killTargets) { $state.targets = @($j.killTargets).Count }
      if ($j.probeErrors) { $state.probeErrors = @($j.probeErrors) }
      if ($j.machine) {
        $state.machProcs = [int]$j.machine.processes
        $state.machEgress = [int]$j.machine.egress
        $state.machBundles = [int]$j.machine.bundles
      } else {
        $state.machProcs = [int]$j.agentProcessCount
        $state.machEgress = [int]$j.egressConnections
        $state.machBundles = [int]$j.bundleArtifacts
      }
      if ($j.perAgent) {
        $state.scoped = $true
        $mine = $j.perAgent.PSObject.Properties[$Client]
        if ($mine) {
          $v = $mine.Value
          $state.mineProcs = [int]$v.procs
          $state.mineEgress = [int]$v.egress
          $state.mineBundles = [int]$v.bundles
          $state.mineAlerts = [int]$v.alerts
          $state.mineTargets = [int]$v.targets
        }
        $un = $j.perAgent.PSObject.Properties['unknown']
        if ($un) { $state.unAlerts = [int]$un.Value.alerts }
      }
    } catch { }
  }
  $eventsPath = Join-Path $Dir 'guard-events.jsonl'
  if (Test-Path $eventsPath) {
    try {
      $line = Get-Content -Tail 1 -Encoding UTF8 $eventsPath
      if ($line) {
        $e = $line | ConvertFrom-Json
        $sev = ([string]$e.severity).ToUpper()
        $state.lastEvent = "[$sev] $($e.title)"
      }
    } catch { }
  }
  return $state
}

function Get-Face {
  param([string]$Mood)
  # 用 Unicode 码点拼表情，避免依赖脚本自身的编码（双保险）
  $dot = [string][char]0x25D5      # ◕
  $joy = [string][char]0x203F      # ‿
  $eye = [string][char]0x25C9      # ◉
  $x   = [string][char]0x2716      # ✖
  $wav = [string][char]0xFE4F      # ﹏
  switch ($Mood) {
    'watching' { return "( $dot$joy$dot )" }
    'alert'    { return "( $eye`_$eye )" }
    'panic'    { return "( $x$wav$x )" }
    default    { return "( $([char]0x30FB)_$([char]0x30FB))" }
  }
}

function Get-Color {
  param([string]$Mood)
  switch ($Mood) {
    'watching' { return '#2ecc71' }
    'alert'    { return '#f1c40f' }
    'panic'    { return '#e74c3c' }
    default    { return '#8899aa' }
  }
}

if ($Probe) {
  $s = Get-GuardState -Dir $DataDir
  Write-Output ("{0}  {1}" -f (Get-Face -Mood $s.mood), $s.headline)
  Write-Output ("状态 {0} · 第 {1} 轮 · agent {2} / 外发 {3} / 打包产物 {4} / 活跃告警 {5} / 候选目标 {6}" -f $s.mood, $s.cycles, $s.agents, $s.egress, $s.bundles, $s.alerts, $s.targets)
  if ($s.probeErrors.Count -gt 0) { Write-Output ("探针降级: " + ($s.probeErrors -join '; ')) }
  if ($s.lastEvent) { Write-Output ("最近事件: " + $s.lastEvent) }
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.Size = New-Object System.Drawing.Size(336, 124)
$form.BackColor = [System.Drawing.Color]::FromArgb(22, 24, 28)
$form.Opacity = 0.93

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$col = $Slot % 3
$row = [math]::Floor($Slot / 3)
$px = $screen.Right - $form.Width - 20 - ($col * ($form.Width + 8))
$py = $screen.Bottom - $form.Height - 20 - ($row * ($form.Height + 8))
if ($px -lt $screen.Left) { $px = $screen.Left + 8 }
if ($py -lt $screen.Top) { $py = $screen.Top + 8 }
$form.Location = New-Object System.Drawing.Point($px, $py)

$face = New-Object System.Windows.Forms.Label
$face.Font = New-Object System.Drawing.Font('Consolas', 20, [System.Drawing.FontStyle]::Bold)
$face.ForeColor = [System.Drawing.Color]::White
$face.AutoSize = $false
$face.TextAlign = 'MiddleCenter'
$face.SetBounds(4, 4, 112, 98)
$form.Controls.Add($face)

$title = New-Object System.Windows.Forms.Label
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::White
$title.AutoSize = $false
$title.TextAlign = 'MiddleLeft'
$title.SetBounds(118, 6, 210, 32)
$form.Controls.Add($title)

$sub = New-Object System.Windows.Forms.Label
$sub.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 7.5)
$sub.ForeColor = [System.Drawing.Color]::FromArgb(150, 155, 165)
$sub.AutoSize = $false
$sub.TextAlign = 'TopLeft'
$sub.SetBounds(120, 38, 214, 84)
$form.Controls.Add($sub)

# 拖动窗口
$script:dragging = $false
$script:dragStart = New-Object System.Drawing.Point(0, 0)
$form.Add_MouseDown({ $script:dragging = $true; $script:dragStart = $_.Location })
$form.Add_MouseMove({
  if ($script:dragging) {
    $p = $form.PointToScreen($_.Location)
    $form.Location = New-Object System.Drawing.Point(($p.X - $script:dragStart.X), ($p.Y - $script:dragStart.Y))
  }
})
$form.Add_MouseUp({ $script:dragging = $false })
$face.Add_MouseDown({ $script:dragging = $true; $script:dragStart = $_.Location })
$face.Add_MouseMove({
  if ($script:dragging) {
    $p = $form.PointToScreen($_.Location)
    $form.Location = New-Object System.Drawing.Point(($p.X - $script:dragStart.X), ($p.Y - $script:dragStart.Y))
  }
})
$face.Add_MouseUp({ $script:dragging = $false })

# 右键菜单
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miDir = $menu.Items.Add('打开数据目录')
$miStatus = $menu.Items.Add('复制状态文本')
$menu.Items.Add('-') | Out-Null
$miExit = $menu.Items.Add('退出桌宠')
$miDir.Add_Click({ Start-Process explorer.exe $DataDir })
$miStatus.Add_Click({
  $s = Get-GuardState -Dir $DataDir
  [System.Windows.Forms.Clipboard]::SetText((("{0} {1}`r`n状态 {2} · 第 {3} 轮 · 活跃告警 {4}" -f (Get-Face -Mood $s.mood), $s.headline, $s.mood, $s.cycles, $s.alerts)))
})
$miExit.Add_Click({ $form.Close() })
$form.ContextMenuStrip = $menu

function Update-Pet {
  $s = Get-GuardState -Dir $DataDir
  $c = Get-Color -Mood $s.mood
  $face.Text = Get-Face -Mood $s.mood
  $face.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($c)
  $form.BackColor = [System.Drawing.Color]::FromArgb(22, 24, 28)

  if ($s.atMs -gt 0) {
    $ageSec = [math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $s.atMs) / 1000)
  } else { $ageSec = -1 }
  $title.Text = if ($s.headline) { $s.headline } else { '尚无采样（守护没在跑）' }
  if ($s.scoped) {
    $line1 = ("{0} 本 agent：进程 {1} 外发 {2} 打包 {3} 告警 {4}" -f $Client.ToUpper(), $s.mineProcs, $s.mineEgress, $s.mineBundles, $s.mineAlerts)
    $line2 = ("全机：进程 {0} 外发 {1} 打包 {2} 未归属 {3}" -f $s.machProcs, $s.machEgress, $s.machBundles, $s.unAlerts)
  } else {
    $line1 = ("{0} · 全机视图（宿主未写归属数据）" -f $Client.ToUpper())
    $line2 = ("全机：进程 {0} 外发 {1} 打包 {2} 告警 {3}" -f $s.machProcs, $s.machEgress, $s.machBundles, $s.mineAlerts)
  }
  $sub.Text = ($line1 + "`r`n" + $line2 + ("`r`n第 {0} 轮 · {1} 秒前采样" -f $s.cycles, $ageSec))
  if ($ageSec -gt 60) { $title.Text = $title.Text + '（快照已过期）' }
  if ($s.probeErrors.Count -gt 0) { $sub.Text = $sub.Text + " · ⚠ 探针降级" }
}

# ── 生命周期：看护客户端主进程，客户端没了就自己退（用户要求"退出即关"）──
# 多锚点是 OR 关系：任一还活着就算客户端还在（pid 与进程名常指向同一个客户端，
# 用 AND 会因为其中一个先退而误判）。
function Test-Watched {
  $any = $false
  if ($WatchPid -gt 0) {
    if (Get-Process -Id $WatchPid -ErrorAction SilentlyContinue) { $any = $true }
  }
  if ($WatchProcess -and $WatchProcess.Trim().Length -gt 0) {
    if (@(Get-Process -Name $WatchProcess -ErrorAction SilentlyContinue).Count -gt 0) { $any = $true }
  }
  if ($WatchPid -le 0 -and (-not $WatchProcess -or $WatchProcess.Trim().Length -eq 0)) { return $true }
  return $any
}

function Remove-OwnLock {
  $lockPath = Join-Path $DataDir ("pet-{0}.lock" -f $Client)
  try { Remove-Item -Force -ErrorAction SilentlyContinue $lockPath } catch { }
}

$lifeTimer = New-Object System.Windows.Forms.Timer
$lifeTimer.Interval = 2000
$script:misses = 0
$lifeTimer.Add_Tick({
  if (Test-Watched) { $script:misses = 0; return }
  # 连续 3 次（约 6 秒）都缺席才关：避免把"壳进程刚退"误判成"客户端退出"
  $script:misses++
  if ($script:misses -ge 3) {
    $lifeTimer.Stop()
    Remove-OwnLock
    $form.Close()
  }
})
if ($WatchPid -gt 0 -or ($WatchProcess -and $WatchProcess.Trim().Length -gt 0)) { $lifeTimer.Start() }

$form.Add_FormClosed({
  $lifeTimer.Stop()
  Remove-OwnLock
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $IntervalMs
$timer.Add_Tick({ Update-Pet })
$timer.Start()

Update-Pet
[void]$form.ShowDialog()
