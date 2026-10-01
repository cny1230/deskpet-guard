# deskpet-guard — WebView2 一体桌宠窗口（0.4.0 阶段 1b）
#
# 一个无边框窗口 = 桌宠形象 + 思考泡 + 就地展开的监控看板（加载采样守护托管的看板页）。
# 页面里的交互（左键看板/右键菜单/思考泡）由看板页自己实现；本脚本只负责：
#   · 宿主窗口（无边框、透明底、默认右下角、可最小化到任务栏）
#   · postMessage 桥：dpg:minimize / dpg:window-drag(dx,dy 增量) / dpg:reset-pos
#
# 参数：
#   -DataDir <目录>     数据目录（读 endpoint.json 找看板；WebView2 用户数据也放这）
#   -Client <名字>      客户端标识（写日志用）
#   -TopMost            置顶显示（默认不置顶）
#   -Width/-Height      窗口尺寸（默认 460x780）
#
# 兜底：缺 WebView2 运行时 / 互操作程序集时，自动转投旧版桌宠脚本（pet.ps1）。
param(
  [string]$DataDir = '',
  [string]$Client = 'manual',
  [int]$Slot = 0,
  [int]$WatchPid = 0,
  [string]$WatchProcess = '',
  [switch]$TopMost,
  [int]$Width = 300,
  [int]$Height = 240
)
$ErrorActionPreference = 'Stop'

# DWM 窗口透明（Accent 策略）：让无边框窗的"没画内容"区域直接透出桌面。
# WebView2 控件配 DefaultBackgroundColor=Transparent（页面 alpha 合成），
# 两者叠加 = 只有桌宠形象和看板可见。品红 TransparencyKey 方案已被实测否决
# （WebView2 是独立子 HWND，窗体颜色键对它误伤——内容一起被抠没）。
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DwmAccent {
  [StructLayout(LayoutKind.Sequential)]
  public struct AccentPolicy { public int AccentState; public int AccentFlags; public uint GradientColor; public int AnimationId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WCAData { public int Attribute; public IntPtr Data; public int SizeOfData; }
  [DllImport("user32.dll")]
  public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WCAData data);
}
"@ -ErrorAction SilentlyContinue

function EnableWindowTransparency([IntPtr]$hwnd) {
  try {
    $policy = New-Object DwmAccent+AccentPolicy
    $policy.AccentState = 6          # ACCENT_ENABLE_TRANSPARENTGRADIENT
    $policy.AccentFlags = 2
    $policy.GradientColor = 0x00000000   # 全透明
    $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(
      [System.Runtime.InteropServices.Marshal]::SizeOf($policy))
    [System.Runtime.InteropServices.Marshal]::StructureToPtr($policy, $ptr, $false)
    $data = New-Object DwmAccent+WCAData
    $data.Attribute = 19             # WCA_ACCENT_POLICY
    $data.Data = $ptr
    $data.SizeOfData = [System.Runtime.InteropServices.Marshal]::SizeOf($policy)
    [void][DwmAccent]::SetWindowCompositionAttribute($hwnd, [ref]$data)
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
  } catch { }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$vendor = Join-Path $root 'vendor\webview2'
$logFile = if ($DataDir) { Join-Path $DataDir 'pet2.log' } else { Join-Path $env:TEMP 'deskpet-guard-pet2.log' }

function Log($msg) {
  try {
    $line = '[' + (Get-Date -Format o) + '] ' + $msg
    if ($DataDir) { Add-Content -LiteralPath $logFile -Value $line -ErrorAction SilentlyContinue }
    else { Write-Host $line }
  } catch {}
}

Log ('pet2 启动 client=' + $Client + ' dataDir=' + $DataDir)

# ── 1) WebView2 运行时探测（Evergreen：注册表 pv；没有就回退旧桌宠）──
$pv = $null
foreach ($key in @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)) {
  try {
    $k = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if ($k -and $k.pv) { $pv = $k.pv; break }
  } catch {}
}
if (-not $pv) {
  Log '未检测到 WebView2 运行时 → 回退旧版桌宠'
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $here 'deskpet-guard-pet.ps1') @PSBoundParameters
  exit $LASTEXITCODE
}
Log ('WebView2 运行时 pv=' + $pv)

# ── 2) 加载互操作程序集（随包 vendor；原生加载器目录加进搜索路径）──
if (-not (Test-Path (Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'))) {
  Log '缺互操作程序集 → 回退旧版桌宠'
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $here 'deskpet-guard-pet.ps1') @PSBoundParameters
  exit $LASTEXITCODE
}
$env:PATH = $vendor + ';' + $env:PATH   # 原生 WebView2Loader.dll 的探测路径
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll')
Add-Type -Path (Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll')

# ── 3) 等采样守护的 endpoint（最长 30s：守护可能还在启动）──
$endpoint = $null
if ($DataDir) {
  $epFile = Join-Path $DataDir 'endpoint.json'
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $ep = Get-Content -LiteralPath $epFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
      if ($ep -and $ep.endpoint -and $ep.atMs -and (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$ep.atMs) -lt 90000)) {
        $endpoint = $ep.endpoint; break
      }
    } catch {}
    Start-Sleep -Milliseconds 1000
  }
}
if (-not $endpoint) { Log '30 秒内没等到守护端点（守护没跑？）→ 仍打开看板页，会显示离线横幅' }
$url = if ($endpoint) { $endpoint.TrimEnd('/') + '/deskpet-guard/dashboard' } else { 'http://127.0.0.1:3080/deskpet-guard/dashboard' }
Log ('看板地址 ' + $url)

# ── 4) 窗体：无边框 + DWM 透明合成（页面透明区=桌面）──
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.Text = 'deskpet-guard'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $true
$form.TopMost = [bool]$TopMost
$form.StartPosition = 'Manual'
$form.BackColor = [System.Drawing.Color]::Black
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
# 收起时窗口只有桌宠形象那么大；看板展开/收起由页面经 dpg:panel-size 通知改尺寸
$form.Size = New-Object System.Drawing.Size(300, 240)
$form.Location = New-Object System.Drawing.Point(($wa.Right - 300 - 8), ($wa.Bottom - 240 - 4))
EnableWindowTransparency $form.Handle

$wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$wv.DefaultBackgroundColor = [System.Drawing.Color]::Transparent
$wv.Dock = [System.Windows.Forms.DockStyle]::Fill
$form.Controls.Add($wv)
$wv.Source = [Uri]$url   # 初始化完成前设置会被控件排队，CoreWebView2 就绪后自动导航

$udf = if ($DataDir) { Join-Path $DataDir 'webview2' } else { Join-Path $env:TEMP 'deskpet-guard-wv2' }

$form.Add_Shown({
  try {
    Log '窗体 Shown → 初始化 CoreWebView2'
    $envTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $udf)
    $env2 = $envTask.GetAwaiter().GetResult()
    $wv.EnsureCoreWebView2Async($env2) | Out-Null   # 完成回调走 CoreWebView2InitializationCompleted
  } catch {
    Log ('CoreWebView2 初始化失败: ' + $_.Exception.Message)
  }
})

$wv.add_CoreWebView2InitializationCompleted({
  try {
    if (-not $wv.CoreWebView2) { Log 'CoreWebView2 为空（初始化失败）'; return }
    $s = $wv.CoreWebView2.Settings
    $s.AreDefaultContextMenusEnabled = $false
    $s.IsStatusBarEnabled = $false
    # postMessage 桥：页面 → 宿主窗口（最小化 / 拖动增量 / 重置位置）
    $wv.CoreWebView2.add_WebMessageReceived({
      param($sender, $ev)
      try {
        $j = $ev.WebMessageAsJson | ConvertFrom-Json
        switch ($j.type) {
          'dpg:minimize' { $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized }
          'dpg:window-drag' {
            $form.Location = New-Object System.Drawing.Point(
              ($form.Location.X + [int]$j.dx), ($form.Location.Y + [int]$j.dy))
          }
          'dpg:reset-pos' {
            $wa2 = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
            $form.Location = New-Object System.Drawing.Point(($wa2.Right - $form.Width - 8), ($wa2.Bottom - $form.Height - 4))
          }
          'dpg:panel-size' {
            # 看板展开/收起时页面通知窗口改尺寸（右下角锚定）
            $nw = [Math]::Max(120, [int]$j.w); $nh = [Math]::Max(120, [int]$j.h)
            $wa2 = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
            $right = $form.Location.X + $form.Width; $bottom = $form.Location.Y + $form.Height
            $nx = [Math]::Min([Math]::Max(0, $right - $nw), ($wa2.Right - $nw))
            $ny = [Math]::Min([Math]::Max(0, $bottom - $nh), ($wa2.Bottom - $nh))
            $form.Size = New-Object System.Drawing.Size($nw, $nh)
            $form.Location = New-Object System.Drawing.Point($nx, $ny)
          }
        }
      } catch { Log ('消息处理异常: ' + $_.Exception.Message) }
    })
    Log 'CoreWebView2 就绪，看板已加载'
  } catch { Log ('初始化回调异常: ' + $_.Exception.Message) }
})

Log '进入消息循环'
[void]$form.ShowDialog()
Log '窗体关闭，退出'
