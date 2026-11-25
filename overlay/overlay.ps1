# 旁座桌面弹窗（只读展示 + 输入回话）
#
# 由 DSH 宿主启动：powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File overlay.ps1 -DataDir <dir>
#
# 数据目录里两个文件：
#   lines.json   宿主写：显示最近 N 句       [{ "t": 1730000000000, "text": "..." }]
#   inbox.jsonl  本窗口写：用户回的话，一行一条 JSON { "t": ..., "text": "..." }
#
# 关键：Show 之后调用 SetWindowDisplayAffinity(hWnd, WDA_EXCLUDEFROMCAPTURE)，
# 让这个窗口对截图 API 不可见 —— 旁座截屏时就不会把自己的弹窗看进去。

param(
  [string]$DataDir,
  [int]$MaxLines = 6
)

$ErrorActionPreference = 'Stop'

if (-not $DataDir) { $DataDir = Join-Path $env:USERPROFILE '.dsh\plugins-data\side-seat\overlay' }
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }
$linesFile = Join-Path $DataDir 'lines.json'
$inboxFile = Join-Path $DataDir 'inbox.jsonl'
$aliveFile = Join-Path $DataDir 'alive.json'
$pidsFile = Join-Path $DataDir 'pids.json'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SideSeatCapture {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
'@

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ResizeMode="CanResizeWithGrip"
        Width="440" Height="330" WindowStartupLocation="Manual"
        FontFamily="Microsoft YaHei UI" FontSize="13">
  <Border x:Name="Root" Background="#C4121216" CornerRadius="12" BorderBrush="#2EFFFFFF" BorderThickness="1" ClipToBounds="True">
    <Grid Margin="12,10,12,10" ClipToBounds="True">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
        <RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>

      <DockPanel Grid.Row="0" LastChildFill="True">
        <Button x:Name="CloseBtn" DockPanel.Dock="Right" Content="&#x2715;" Width="24" Height="22"
                Background="Transparent" BorderThickness="0" Foreground="#B3FFFFFF" Cursor="Hand"
                ToolTip="关闭弹窗（可从旁座面板重新打开）"/>
        <Button x:Name="PinBtn" DockPanel.Dock="Right" Content="&#x25CB;" Width="24" Height="22"
                Background="Transparent" BorderThickness="0" Foreground="#B3FFFFFF" Cursor="Hand"
                ToolTip="钉住：切换置顶"/>
        <TextBlock x:Name="Title" Text="旁座" Foreground="#8AFFFFFF" FontSize="11" VerticalAlignment="Center"/>
      </DockPanel>

      <ScrollViewer x:Name="Scroll" Grid.Row="1" VerticalScrollBarVisibility="Hidden" HorizontalScrollBarVisibility="Disabled" Margin="0,6,0,6">
        <StackPanel x:Name="Msgs" VerticalAlignment="Bottom"/>
      </ScrollViewer>

      <DockPanel Grid.Row="2">
        <Button x:Name="SendBtn" DockPanel.Dock="Right" Content="&#x21B5;" Width="26" Height="24" Margin="6,0,0,0"
                Background="#22FFFFFF" BorderThickness="0" Foreground="#F2FFFFFF" Cursor="Hand" ToolTip="发送（回车）"/>
        <TextBox x:Name="Input" Height="24" Background="#1AFFFFFF" BorderThickness="0" Foreground="#F2FFFFFF"
                 CaretBrush="#F2FFFFFF" Padding="6,2" VerticalContentAlignment="Center"
                 ToolTip="直接回它一句，会发进旁座会话"/>
      </DockPanel>
    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$win = [Windows.Markup.XamlReader]::Load($reader)

$root = $win.FindName('Root')
$msgs = $win.FindName('Msgs')
$scroll = $win.FindName('Scroll')
# 变量名不能叫 $input：那是 PowerShell 的自动变量（管道枚举器），
# 在函数里 $input.Text 恒为空，发送会静默失败。
$inputBox = $win.FindName('Input')
$pinBtn = $win.FindName('PinBtn')
$closeBtn = $win.FindName('CloseBtn')
$sendBtn = $win.FindName('SendBtn')

# Position and size: bottom-right of the WPF work area, sized to the screen.
# Must use SystemParameters.WorkArea — it is in DIPs, same unit as Window.Left/Top.
# WinForms Screen.WorkingArea returns PHYSICAL pixels; under display scaling that
# pushed the window completely off-screen (2096,1014 on a 1707x960 DIP screen).
$wa = [System.Windows.SystemParameters]::WorkArea
$w = [Math]::Min(560.0, [Math]::Max(320.0, [Math]::Round($wa.Width * 0.32)))
$h = [Math]::Min(440.0, [Math]::Max(240.0, [Math]::Round($wa.Height * 0.42)))
$win.Width = $w
$win.Height = $h
$left = $wa.Right - $w - 24
$top = $wa.Bottom - $h - 24
if ($left -lt 0) { $left = 0 }
if ($top -lt 0) { $top = 0 }
$win.Left = $left
$win.Top = $top

$script:pinned = $false
$script:lastText = ''

function Set-PinLook {
  if ($script:pinned) { $pinBtn.Content = [char]0x25CF; $pinBtn.Foreground = '#FF6FA8FF' }
  else { $pinBtn.Content = [char]0x25CB; $pinBtn.Foreground = '#B3FFFFFF' }
}

$pinBtn.Add_Click({
  $script:pinned = -not $script:pinned
  $win.Topmost = $true   # 始终置顶，图钉只锁位置
  Set-PinLook
})

$closeBtn.Add_Click({ $win.Close() })

# drag the window when it is not pinned
$root.Add_MouseLeftButtonDown({
  param($sender, $e)
  if (-not $script:pinned) {
    try { $win.DragMove() } catch { }
  }
})

function Send-Input {
  $text = $inputBox.Text
  # send.log：连"点没点、发没发、内容多长"都记下来，发不出去时能直接分清是控件没响应还是宿主没收到
  try {
    [System.IO.File]::AppendAllText((Join-Path $DataDir 'send.log'),
      ("t={0} len={1} text={2}`n" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), [string]$text.Length, $text),
      [System.Text.Encoding]::UTF8)
  } catch { }
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  $obj = @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); text = $text } | ConvertTo-Json -Compress
  try { [System.IO.File]::AppendAllText($inboxFile, $obj + "`n", [System.Text.Encoding]::UTF8) } catch { }
  $inputBox.Text = ''
}

$sendBtn.Add_Click({ Send-Input })
$inputBox.Add_KeyDown({
  param($sender, $e)
  if ($e.Key -eq [System.Windows.Input.Key]::Return) { Send-Input; $e.Handled = $true }
})

# 气泡配色（对齐 Harness 对话：自己在右、对方在左）
$conv = New-Object System.Windows.Media.BrushConverter
$brushUser = $conv.ConvertFromString('#3A5BC7')
$brushUserText = $conv.ConvertFromString('#FFFFFF')
$brushPeer = $conv.ConvertFromString('#2B2B33')
$brushPeerText = $conv.ConvertFromString('#F2F2F5')

function Render-Messages($items) {
  $msgs.Children.Clear()
  $maxW = 260.0
  try { if ($win.ActualWidth -gt 120) { $maxW = [Math]::Floor($win.ActualWidth * 0.76) } } catch { }
  foreach ($m in $items) {
    $text = [string]$m.text
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    $isUser = $false
    if ($m.PSObject.Properties.Name -contains 'role') { $isUser = ($m.role -eq 'user') }

    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $text
    $tb.TextWrapping = 'Wrap'
    $tb.FontSize = 13
    $tb.LineHeight = 20

    $b = New-Object System.Windows.Controls.Border
    $b.CornerRadius = New-Object System.Windows.CornerRadius 10
    $b.Padding = New-Object System.Windows.Thickness 10,6,10,6
    $b.Margin = New-Object System.Windows.Thickness 0,2,0,0
    $b.MaxWidth = $maxW
    if ($isUser) {
      $b.Background = $brushUser
      $tb.Foreground = $brushUserText
    } else {
      $b.Background = $brushPeer
      $tb.Foreground = $brushPeerText
      $b.BorderBrush = $conv.ConvertFromString('#33FFFFFF')
      $b.BorderThickness = New-Object System.Windows.Thickness 1
    }
    $b.Child = $tb

    # 发送者标签放在气泡外面（上方），不会和正文混在一起
    $cap = New-Object System.Windows.Controls.TextBlock
    $cap.Text = $(if ($isUser) { '你' } else { '旁座' })
    $cap.FontSize = 10
    $cap.Opacity = 0.6
    $cap.Margin = New-Object System.Windows.Thickness 2,6,2,0
    $cap.HorizontalAlignment = $(if ($isUser) { 'Right' } else { 'Left' })

    $col = New-Object System.Windows.Controls.StackPanel
    $col.Margin = New-Object System.Windows.Thickness 0,4,0,6
    $col.HorizontalAlignment = $(if ($isUser) { 'Right' } else { 'Left' })
    [void]$col.Children.Add($cap)
    [void]$col.Children.Add($b)
    [void]$msgs.Children.Add($col)
  }
  try { $scroll.ScrollToEnd() } catch { }

  # 渲染快照：画了几条、每条的角色和文本。视觉与数据不一致时靠它定位。
  try {
    $dump = @()
    foreach ($m in $items) {
      $r = 'assistant'
      if ($m.PSObject.Properties.Name -contains 'role') { $r = [string]$m.role }
      $dump += @{ role = $r; text = [string]$m.text }
    }
    $snap = @{ children = $msgs.Children.Count; items = $dump; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    ($snap | ConvertTo-Json -Depth 6 -Compress) | Set-Content -Path (Join-Path $DataDir 'render.json') -Encoding UTF8
  } catch { }
}

# 轮询宿主写来的行
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(400)
$timer.Add_Tick({
  try {
    if (Test-Path $linesFile) {
      $raw = [System.IO.File]::ReadAllText($linesFile, [System.Text.Encoding]::UTF8)
      if ($raw -and $raw.Trim()) {
        $parsed = $raw | ConvertFrom-Json
        # PS 5.1 的 ConvertFrom-Json 把 JSON 数组当成「一个对象」返回（PS 6+ 才展开）。
        # 直接接 Select-Object -Last 会得到「装着数组的数组」，foreach 只迭代一次，
        # [string]$m.text 就把所有消息用空格拼进一个气泡里。
        $all = @()
        foreach ($x in $parsed) { $all += $x }
        if ($all.Count -gt $MaxLines) { $all = $all[($all.Count - $MaxLines)..($all.Count - 1)] }
        $items = $all
        $key = (@($items | ForEach-Object { "$($_.t)|$($_.role)|$($_.text)" }) -join "`n")
        if ($key -ne $script:lastText) {
          $script:lastText = $key
          Render-Messages $items
        }
      }
    }
    $hb = @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); pid = $PID } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($aliveFile, $hb, [System.Text.Encoding]::UTF8)
  } catch { }
})
$timer.Start()

$win.Add_Closed({
  try { $timer.Stop() } catch { }
  try { if (Test-Path $aliveFile) { Remove-Item -Force $aliveFile } } catch { }
  # 从实例登记表里摘掉自己，别让下次启动误杀
  try {
    if (Test-Path $pidsFile) {
      $mine = @(Get-Content $pidsFile -Raw | ConvertFrom-Json | Where-Object { [int]$_ -ne $PID })
      if ($mine.Count) { $mine | ConvertTo-Json -Compress | Set-Content $pidsFile -Encoding UTF8 }
      else { Remove-Item -Force $pidsFile -ErrorAction SilentlyContinue }
    }
  } catch { }
})

$win.Add_ContentRendered({
  # 系统级的边缘/角落缩放：WindowChrome 让无边框窗口也有 Windows 标准的 6px 抓取边。
  # 它和 AllowsTransparency 不一定共存，失败就退回 ResizeMode 自带的右下角手柄。
  try {
    Add-Type -AssemblyName PresentationFramework
    $chrome = New-Object System.Windows.Shell.WindowChrome
    $chrome.CaptionHeight = 0
    $chrome.ResizeBorderThickness = New-Object System.Windows.Thickness 6
    $chrome.GlassFrameThickness = New-Object System.Windows.Thickness 0
    $chrome.CornerRadius = New-Object System.Windows.CornerRadius 12
    $chrome.UseAeroCaptionButtons = $false
    [System.Windows.Shell.WindowChrome]::SetWindowChrome($win, $chrome)
  } catch { }
  $info = @{ excluded = $false; left = 0; top = 0; width = 0; height = 0; hwnd = 0 }
  try {
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($win)
    $info.hwnd = [int64]$helper.Handle
    # powershell.exe -WindowStyle Hidden 会让进程创建的第一个窗口继承 SW_HIDE，
    # WPF 窗口因此存在却看不见。显式 ShowWindow(SW_SHOW=5) 覆盖它。
    [void][SideSeatCapture]::ShowWindow($helper.Handle, 5)
    # HWND_TOPMOST(-1) + SWP_NOMOVE|SWP_NOSIZE(0x0002|0x0001)，确保压在最上面
    [void][SideSeatCapture]::SetWindowPos($helper.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x0003)
    # 0x11 = WDA_EXCLUDEFROMCAPTURE：本窗口从截图里消失。返回值说明系统是否接受。
    # 调试用：SIDE_SEAT_OVERLAY_NOEXCLUDE=1 时跳过排除，方便截图检查布局。
    if ($env:SIDE_SEAT_OVERLAY_NOEXCLUDE -eq '1') {
      $info.excluded = $false
    } else {
      $info.excluded = [bool][SideSeatCapture]::SetWindowDisplayAffinity($helper.Handle, 0x11)
    }
    $info.left = [int]$win.Left
    $info.top = [int]$win.Top
    $info.width = [int]$win.Width
    $info.height = [int]$win.Height
    $info.screenW = [int]$wa.Width
    $info.screenH = [int]$wa.Height
    # 把脚本版本号回写，宿主据此判断这个窗口是不是旧脚本开的
    try {
      $ef = Join-Path $DataDir 'expected.json'
      if (Test-Path $ef) { $info.v = [string]((Get-Content $ef -Raw) | ConvertFrom-Json).v }
    } catch { }
  } catch { }
  try {
    $info | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $DataDir 'window.json') -Encoding UTF8
  } catch { }
})

Set-PinLook

# 实例登记：宿主下次启动据此清掉所有残留实例（否则多个窗口会叠在一起）
try {
  $list = @()
  if (Test-Path $pidsFile) { $list = @(Get-Content $pidsFile -Raw | ConvertFrom-Json) }
  $list = @(@($list | ForEach-Object { [int]$_ }) + $PID | Select-Object -Unique)
  $list | ConvertTo-Json -Compress | Set-Content $pidsFile -Encoding UTF8
} catch { }

[void]$win.ShowDialog()
