<#
.SYNOPSIS
  PowerMill COM 自动化桥接脚本
.DESCRIPTION
  通过 Windows COM Automation 连接运行中的 PowerMill 实例，
  读取项目状态、刀具路径、刀具信息，导出截图，或执行宏命令。
  供 Node.js 后端通过 child_process 调用。
.NOTES
  ProgID: PowerMILL.Application
  参考舅舅 pm_connector.py 的核心逻辑，改写为 PowerShell 版本。
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('status', 'toolpaths', 'tools', 'features', 'screenshot', 'execute', 'ncprograms')]
    [string]$Action,

    [string]$Command  = '',
    [string]$OutputPath = '',
    [string]$View = ''
)

# 强制 UTF-8 输出，避免中文乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

<#
  连接到运行中的 PowerMill 实例
  只通过 ROT (Running Object Table) 获取用户已启动的实例。
  注意: 绝不使用 New-Object 创建新实例，否则会产生隐藏的空 PowerMill 进程，
        导致 COM 连接到空实例而非用户实际使用的窗口。
#>
function Connect-PowerMill {
    try {
        $pm = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerMILL.Application')
        # 验证连接的是可见实例（用户正在使用的）
        if (-not $pm.Visible) {
            # 可能连到了隐藏实例，释放并报错
            [Runtime.InteropServices.Marshal]::ReleaseComObject($pm) | Out-Null
            return $null
        }
        return $pm
    } catch {
        return $null
    }
}

<#
  执行 PowerMill 宏命令（不获取输出）
  注意: PowerMill 2026 COM 接口中 DoCommandEx/Execute 不接受单参数，
  需使用 DoCommand 方法执行命令。
  获取命令输出请使用 Get-PMParameter (GetParameterXML)。
#>
function Invoke-PMMacro {
    param($pm, [string]$cmd)
    # 注意: COM 方法返回值会进入 PowerShell 管道，必须用 Out-Null 丢弃
    try {
        $pm.DoCommand($cmd) | Out-Null
    } catch {}
    return ''
}

<#
  通过 GetParameterXML 获取参数值（推荐方式）
  返回 XML 格式，需解析 InnerText 获取值
  注意: 某些参数（如未打开项目时的 PROJECTPATH）会返回 HRESULT 错误码，
  需检查返回值类型。
#>
function Get-PMParameter {
    param($pm, [string]$paramName)
    try {
        $result = $pm.GetParameterXML($paramName)
        # 只接受以 < 开头的字符串（有效 XML），过滤 HRESULT 错误码
        if ($result -is [string] -and $result.Trim().StartsWith('<')) {
            $doc = [xml]$result
            return $doc.DocumentElement.InnerText.Trim()
        }
    } catch {}
    return ''
}

<#
  安全读取属性，失败返回默认值
#>
function Get-PMProperty {
    param($obj, [string]$prop, $default = '')
    try {
        $val = $obj.$prop
        if ($null -ne $val -and $val -ne '') { return "$val" }
    } catch {}
    return $default
}

<#
  控制 PowerMill UI 元素显隐，截图前隐藏、截图后恢复
#>
function Set-PMUIVisibility {
    param($pm, [bool]$visible)
    # 注意：PowerMill 2027 没有 FORM RIBBON MINIMISE/MAXIMISE 命令，
    # 我们通过 Win32 API 直接裁剪到 3D 视口窗口来排除 Ribbon。
    $commands = if ($visible) {
        @(
            'EXPLORER RAISE',
            'STATUS RAISE',
            'TOOLBAR COMMANDBAR RAISE',
            'TOOLBAR EXPRESSIONBAR RAISE',
            'PLUGIN PANES RAISE',
            'PLUGIN TABS RAISE',
            'TOOLBAR VIEWING RAISE'
        )
    } else {
        @(
            'EXPLORER LOWER',
            'STATUS LOWER',
            'TOOLBAR COMMANDBAR LOWER',
            'TOOLBAR EXPRESSIONBAR LOWER',
            'PLUGIN PANES LOWER',
            'PLUGIN TABS LOWER',
            'TOOLBAR VIEWING LOWER'
        )
    }
    # 一次性批量发送命令，避免每条命令后都等待，提高截图速度
    foreach ($cmd in $commands) {
        try { Invoke-PMMacro $pm $cmd } catch {}
    }
    Start-Sleep -Milliseconds 500
}

# ========== 主逻辑 ==========

$pm = Connect-PowerMill

if ($null -eq $pm) {
    $result = @{
        success = $false
        error   = '无法连接 PowerMill，请确保 PowerMill 已启动并已打开项目'
    }
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 0
}

try {
    switch ($Action) {

        # ---- 读取当前项目状态 ----
        'status' {
            # 优先使用 GetParameterXML 获取参数值（推荐方式）
            $projectName = Get-PMParameter $pm 'PROJECTNAME'
            $projectPath = Get-PMParameter $pm 'PROJECTPATH'
            $units       = (Get-PMParameter $pm 'units').ToUpper()

            # 如果 GetParameterXML 没拿到，尝试 COM 对象属性
            if ([string]::IsNullOrWhiteSpace($projectName)) {
                try { $projectName = Get-PMProperty $pm.Project 'Name' '' } catch {}
            }
            if ([string]::IsNullOrWhiteSpace($projectPath)) {
                try { $projectPath = Get-PMProperty $pm.Project 'Path' '' } catch {}
            }

            # 项目名可通过路径推断
            if ([string]::IsNullOrWhiteSpace($projectName) -and $projectPath) {
                $projectName = [System.IO.Path]::GetFileNameWithoutExtension($projectPath)
            }
# 激活的刀具路径
            $activeToolpath = Get-PMParameter $pm "entity('toolpath','').name"
            if ($activeToolpath -match '^(ERROR|NONE|0|\s*)$') { $activeToolpath = '' }

            # 激活的刀具
            $activeTool = Get-PMParameter $pm "entity('tool','').name"
            if ($activeTool -match '^(ERROR|NONE|0|\s*)$') { $activeTool = '' }

            # 激活的边界
            $activeBoundary = Get-PMParameter $pm "entity('boundary','').name"
            if ($activeBoundary -match '^(ERROR|NONE|0|\s*)$') { $activeBoundary = '' }

            # 激活的 NC 程序
            $activeNC = Get-PMParameter $pm "entity('ncprogram','').name"
            if ($activeNC -match '^(ERROR|NONE|0|\s*)$') { $activeNC = '' }

            # 统计数量
            $toolpathCount = 0
            $toolCount     = 0
            try {
                $toolpathCount = $pm.Project.Toolpaths.Count
                $toolCount     = $pm.Project.Tools.Count
            } catch {
                $tpStr = "$(Invoke-PMMacro $pm 'PRINT $toolpath')".Trim()
                if ($tpStr -match '(\d+)') { $toolpathCount = [int]$Matches[1] }
                $toolStr = "$(Invoke-PMMacro $pm 'PRINT $tool')".Trim()
                if ($toolStr -match '(\d+)') { $toolCount = [int]$Matches[1] }
            }

            # 单位转换
            $unitsStr = if ($units -eq 'METRIC') { 'mm' }
                        elseif ($units -eq 'IMPERIAL') { 'inches' }
                        elseif ($units) { $units.ToLower() }
                        else { '' }

            $result = @{
                success         = $true
                projectName     = $projectName
                projectPath     = $projectPath
                units           = $unitsStr
                activeToolpath  = $activeToolpath
                activeTool      = $activeTool
                activeBoundary  = $activeBoundary
                activeNCProgram = $activeNC
                toolpathCount   = $toolpathCount
                toolCount       = $toolCount
                timestamp       = (Get-Date).ToString('o')
            }
        }

        # ---- 列出所有刀具路径 ----
        'toolpaths' {
            $toolpaths = @()
            try {
                # 尝试通过集合枚举
                foreach ($tp in $pm.Project.Toolpaths) {
                    $name = Get-PMProperty $tp 'Name' ''
                    if ($name) {
                        $toolpaths += @{
                            name        = $name
                            tool        = Get-PMProperty $tp 'Tool' ''
                            status      = Get-PMProperty $tp 'Status' ''
                            strategy    = Get-PMProperty $tp 'Strategy' ''
                            feedRate    = Get-PMProperty $tp 'FeedRate' ''
                            spindleSpeed = Get-PMProperty $tp 'SpindleSpeed' ''
                        }
                    }
                }
            } catch {
                # 降级：用宏命令列出
                $list = Invoke-PMMacro $pm 'PRINT $toolpath'
                $lines = $list -split "`n" | Where-Object { $_.Trim() -ne '' }
                foreach ($line in $lines) {
                    $name = $line.Trim()
                    if ($name -and $name -notmatch '^(Toolpath|\s)') {
                        $toolpaths += @{ name = $name }
                    }
                }
            }
            $result = @{
                success   = $true
                toolpaths = $toolpaths
                count     = $toolpaths.Count
            }
        }

        # ---- 列出所有刀具 ----
        'tools' {
            $tools = @()
            try {
                foreach ($t in $pm.Project.Tools) {
                    $name = Get-PMProperty $t 'Name' ''
                    if ($name) {
                        $tools += @{
                            name      = $name
                            type      = Get-PMProperty $t 'Type' ''
                            diameter  = Get-PMProperty $t 'Diameter' ''
                            length    = Get-PMProperty $t 'Length' ''
                            toolNumber = Get-PMProperty $t 'ToolNumber' ''
                        }
                    }
                }
            } catch {
                $list = Invoke-PMMacro $pm 'PRINT $tool'
                $lines = $list -split "`n" | Where-Object { $_.Trim() -ne '' }
                foreach ($line in $lines) {
                    $name = $line.Trim()
                    if ($name -and $name -notmatch '^(Tool|\s)') {
                        $tools += @{ name = $name }
                    }
                }
            }
            $result = @{
                success = $true
                tools   = $tools
                count   = $tools.Count
            }
        }

        # ---- 列出所有特征 ----
        'features' {
            $features = @()
            $list = Invoke-PMMacro $pm 'PRINT $feature'
            $lines = $list -split "`n" | Where-Object { $_.Trim() -ne '' }
            foreach ($line in $lines) {
                $name = $line.Trim()
                if ($name) {
                    $features += @{ name = $name }
                }
            }
            $result = @{
                success  = $true
                features = $features
                count    = $features.Count
            }
        }

        # ---- 列出所有 NC 程序 ----
        'ncprograms' {
            $ncprograms = @()
            try {
                foreach ($nc in $pm.Project.NCPrograms) {
                    $name = Get-PMProperty $nc 'Name' ''
                    if ($name) {
                        $ncprograms += @{
                            name     = $name
                            toolpath = Get-PMProperty $nc 'Toolpath' ''
                            status   = Get-PMProperty $nc 'Status' ''
                        }
                    }
                }
            } catch {
                $list = Invoke-PMMacro $pm 'PRINT $ncprogram'
                $lines = $list -split "`n" | Where-Object { $_.Trim() -ne '' }
                foreach ($line in $lines) {
                    $name = $line.Trim()
                    if ($name -and $name -notmatch '^(NCProgram|\s)') {
                        $ncprograms += @{ name = $name }
                    }
                }
            }
            $result = @{
                success    = $true
                ncprograms = $ncprograms
                count      = $ncprograms.Count
            }
        }

        # ---- 导出当前视图截图 ----
        # PM 2027 不支持 EXPORT IMAGE FILE 宏命令，
        # 改用 PrintWindow API 截取 PowerMill 窗口内容（即使窗口被部分遮挡也能捕获）。
        'screenshot' {
            if ([string]::IsNullOrWhiteSpace($OutputPath)) {
                $result = @{ success = $false; error = 'OutputPath required' }
                break
            }
            # 确保目录存在
            $dir = Split-Path $OutputPath -Parent
            if ($dir -and !(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

            # 如果已存在同名文件先删除
            if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force -ErrorAction SilentlyContinue }

            # 加载 .NET 程序集
            Add-Type -AssemblyName System.Drawing

            # 设置当前 PowerShell 进程为 DPI 感知，避免高 DPI 缩放导致窗口坐标/截图错位
            try {
                $dpiType = Add-Type -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@ -Name DpiAware -Namespace Win32 -PassThru
                $dpiType::SetProcessDPIAware() | Out-Null
            } catch {}

            # 查找 PowerMill 进程（进程名可能是 pmill 或 PowerMILL，依版本/安装方式而定）
            # 不再强制要求 MainWindowHandle != 0，因为某些版本该句柄可能为 0，
            # 后续会结合 EnumWindows 按进程 ID 查找真正的可视窗口。
            $pmProcess = Get-Process -Name 'pmill', 'PowerMILL' -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if (-not $pmProcess) {
                $result = @{ success = $false; error = '找不到 PowerMill 进程，请确保 PowerMill 已启动' }
                break
            }

            # 截图前隐藏资源管理器、状态栏、工具栏等 UI 元素
            # 先隐藏 UI，再切换视角/自适应缩放，确保基于最终视口尺寸计算。
            Set-PMUIVisibility $pm $false
            Start-Sleep -Milliseconds 600

            # 如有指定视角，通过 PowerMill 宏命令切换视图
            # PowerMill 2027 使用 ROTATE TRANSFORM 系列命令切换标准视图
            $viewMap = @{
                'iso'     = 'ROTATE TRANSFORM ISO1'
                'front'   = 'ROTATE TRANSFORM FRONT'
                'top'     = 'ROTATE TRANSFORM TOP'
                'left'    = 'ROTATE TRANSFORM LEFT'
                'right'   = 'ROTATE TRANSFORM RIGHT'
                'back'    = 'ROTATE TRANSFORM BACK'
                'bottom'  = 'ROTATE TRANSFORM BOTTOM'
            }
            if ($View -and $viewMap.ContainsKey($View.ToLower())) {
                try {
                    Invoke-PMMacro $pm $viewMap[$View.ToLower()]
                    Start-Sleep -Milliseconds 1200
                } catch {}
            }

            # 使用 Win32 API 捕获 PowerMill 客户区（去掉标题栏/Ribbon/边框）
            # 用单引号 here-string 避免 PowerShell 解析 C# 代码中的特殊字符；结束符必须顶格
            $csSource = @'
using System;
using System.Drawing;
using System.Text;
using System.Runtime.InteropServices;
public class PMWindowCapture {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    static PMWindowCapture() {
        try { SetProcessDPIAware(); } catch {}
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, uint dwRop);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    public const uint SRCCOPY = 0x00CC0020;

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool AllowSetForegroundWindow(int dwProcessId);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    public const int SW_SHOWNORMAL = 1;
    public const int SW_SHOWMAXIMIZED = 3;

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    public static readonly IntPtr HWND_TOP = new IntPtr(0);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_SHOWWINDOW = 0x0040;

    public delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X, Y;
    }

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    // 当 MainWindowHandle 指向隐藏窗口时，尝试按进程+标题查找真正的可视窗口
    public static IntPtr FindPowerMillWindow(uint targetPid) {
        IntPtr best = IntPtr.Zero;
        IntPtr fallback = IntPtr.Zero;
        int bestArea = 0;
        int fallbackArea = 0;
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid != targetPid || !IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string title = sb.ToString();
            RECT rc;
            if (!GetClientRect(hWnd, out rc)) return true;
            int area = (rc.Right - rc.Left) * (rc.Bottom - rc.Top);
            if (area <= 50 * 50) return true; // 过滤过小的弹窗/提示
            // 优先使用标题匹配 PowerMill/Autodesk 的窗口
            if (title.IndexOf("PowerMill", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("Autodesk", StringComparison.OrdinalIgnoreCase) >= 0) {
                if (area > bestArea) {
                    bestArea = area;
                    best = hWnd;
                }
            } else if (area > fallbackArea) {
                // 无标题匹配时，保留同进程最大可视窗口作为兜底
                fallbackArea = area;
                fallback = hWnd;
            }
            return true;
        }, IntPtr.Zero);
        return best != IntPtr.Zero ? best : fallback;
    }

    // 查找 MDI 客户区窗口：即 Ribbon 下方的 3D 视图区域容器
    public static IntPtr FindMDIClient(IntPtr mainHwnd) {
        IntPtr mdiClient = IntPtr.Zero;
        EnumChildWindows(mainHwnd, (hWnd, lParam) => {
            StringBuilder cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            if (cls.ToString() == "MDIClient") {
                mdiClient = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return mdiClient;
    }

    // 将目标窗口强制置前（即使从非交互式子进程调用也尽量成功）
    public static void ForceForegroundWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return;
        AllowSetForegroundWindow(-1);
        uint targetThread, currentThread = GetCurrentThreadId();
        GetWindowThreadProcessId(hWnd, out targetThread);
        // 附加输入线程，使 SetForegroundWindow 更容易成功
        AttachThreadInput(currentThread, targetThread, true);
        ShowWindowAsync(hWnd, SW_SHOWNORMAL);
        SetForegroundWindow(hWnd);
        AttachThreadInput(currentThread, targetThread, false);
    }

    // 查找真正的 3D 视口子窗口（AfxFrameOrView 类），它比 MDIClient 更精确
    public static IntPtr FindViewportWindow(IntPtr mainHwnd) {
        IntPtr mdi = FindMDIClient(mainHwnd);
        if (mdi == IntPtr.Zero) return IntPtr.Zero;
        IntPtr best = IntPtr.Zero;
        int bestArea = 0;
        EnumChildWindows(mdi, (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            if (cls.ToString().StartsWith("AfxFrameOrView")) {
                RECT rc;
                GetWindowRect(hWnd, out rc);
                int area = (rc.Right - rc.Left) * (rc.Bottom - rc.Top);
                if (area > bestArea) {
                    bestArea = area;
                    best = hWnd;
                }
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // 使用 BitBlt 从桌面 DC 复制指定屏幕区域。
    // 这种方式能捕获 OpenGL/DirectX 3D 视口的真实渲染内容，
    // 而 PrintWindow 直接截取子窗口经常会得到黑屏。
    private static Bitmap CaptureScreenRegion(RECT rc) {
        int width = rc.Right - rc.Left;
        int height = rc.Bottom - rc.Top;
        if (width <= 0 || height <= 0) return null;

        IntPtr hdcSrc = GetDC(IntPtr.Zero);
        IntPtr hdcDest = CreateCompatibleDC(hdcSrc);
        IntPtr hBitmap = CreateCompatibleBitmap(hdcSrc, width, height);
        IntPtr hOld = SelectObject(hdcDest, hBitmap);
        BitBlt(hdcDest, 0, 0, width, height, hdcSrc, rc.Left, rc.Top, SRCCOPY);
        SelectObject(hdcDest, hOld);
        DeleteDC(hdcDest);
        ReleaseDC(IntPtr.Zero, hdcSrc);

        Bitmap bmp = Bitmap.FromHbitmap(hBitmap);
        DeleteObject(hBitmap);
        return bmp;
    }

    // 检测 Bitmap 是否近似全黑
    private static bool IsMostlyBlack(Bitmap bmp, int step) {
        for (int y = 0; y < bmp.Height; y += step) {
            for (int x = 0; x < bmp.Width; x += step) {
                Color c = bmp.GetPixel(x, y);
                if (c.R > 15 || c.G > 15 || c.B > 15) return false;
            }
        }
        return true;
    }

    // 使用 PrintWindow 直接捕获整个窗口（含非客户区）
    private static Bitmap CaptureWindowDirect(IntPtr hWnd, uint flags) {
        RECT rc;
        if (!GetWindowRect(hWnd, out rc)) return null;
        int w = rc.Right - rc.Left;
        int h = rc.Bottom - rc.Top;
        if (w <= 0 || h <= 0) return null;
        Bitmap bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (Graphics gfx = Graphics.FromImage(bmp)) {
            IntPtr hdc = gfx.GetHdc();
            PrintWindow(hWnd, hdc, flags);
            gfx.ReleaseHdc(hdc);
        }
        return bmp;
    }

    // 使用 PrintWindow 捕获主窗口后裁剪指定区域。
    // PrintWindow 坐标系原点在窗口左上角（含非客户区边框），
    // 因此源矩形需用屏幕坐标差值计算。
    private static Bitmap CaptureByPrintWindow(IntPtr hWnd, RECT targetRc, uint flags) {
        RECT windowRc;
        GetWindowRect(hWnd, out windowRc);
        int targetWidth = targetRc.Right - targetRc.Left;
        int targetHeight = targetRc.Bottom - targetRc.Top;
        if (targetWidth <= 0 || targetHeight <= 0) return null;

        Bitmap whole = new Bitmap(windowRc.Right - windowRc.Left, windowRc.Bottom - windowRc.Top,
            System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (Graphics gfx = Graphics.FromImage(whole)) {
            IntPtr hdc = gfx.GetHdc();
            PrintWindow(hWnd, hdc, flags);
            gfx.ReleaseHdc(hdc);
        }

        Bitmap result = new Bitmap(targetWidth, targetHeight, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(result)) {
            int srcX = targetRc.Left - windowRc.Left;
            int srcY = targetRc.Top - windowRc.Top;
            g.DrawImage(whole,
                new Rectangle(0, 0, targetWidth, targetHeight),
                new Rectangle(srcX, srcY, targetWidth, targetHeight),
                GraphicsUnit.Pixel);
        }
        whole.Dispose();
        return result;
    }

    public static Bitmap CaptureClient(IntPtr hWnd, IntPtr mdiClientHwnd, IntPtr viewportHwnd) {
        // 目标截图区域：优先使用真正的 3D 视口窗口，其次 MDIClient，最后主窗口客户区
        RECT targetRc = new RECT();
        string source = "main";
        if (viewportHwnd != IntPtr.Zero && IsWindowVisible(viewportHwnd)) {
            if (GetWindowRect(viewportHwnd, out targetRc)) {
                int w = targetRc.Right - targetRc.Left;
                int h = targetRc.Bottom - targetRc.Top;
                if (w > 100 && h > 100) source = "viewport";
            }
        }

        if (source == "main" && mdiClientHwnd != IntPtr.Zero && IsWindowVisible(mdiClientHwnd)) {
            if (GetWindowRect(mdiClientHwnd, out targetRc)) {
                int w = targetRc.Right - targetRc.Left;
                int h = targetRc.Bottom - targetRc.Top;
                if (w > 100 && h > 100) source = "mdi";
            }
        }

        if (source == "main") {
            // 回退：使用主窗口客户区
            RECT clientRc;
            GetClientRect(hWnd, out clientRc);
            POINT pt = new POINT { X = clientRc.Left, Y = clientRc.Top };
            ClientToScreen(hWnd, ref pt);
            targetRc.Left = pt.X;
            targetRc.Top = pt.Y;
            targetRc.Right = pt.X + (clientRc.Right - clientRc.Left);
            targetRc.Bottom = pt.Y + (clientRc.Bottom - clientRc.Top);
        }

        int targetWidth = targetRc.Right - targetRc.Left;
        int targetHeight = targetRc.Bottom - targetRc.Top;
        Console.WriteLine("DEBUG targetRc={0},{1},{2},{3} source={4}",
            targetRc.Left, targetRc.Top, targetRc.Right, targetRc.Bottom, source);
        if (targetWidth <= 0 || targetHeight <= 0) return null;

        // 策略1：优先 PrintWindow 主窗口后裁剪到目标区域。
        // 这种方式不依赖 DPI 缩放，也不依赖窗口是否在最前，最稳定。
        Bitmap mainPw = CaptureByPrintWindow(hWnd, targetRc, 2);
        if (mainPw != null && !IsMostlyBlack(mainPw, 10)) {
            Console.WriteLine("DEBUG using PrintWindow main crop {0}x{1}", mainPw.Width, mainPw.Height);
            return mainPw;
        }
        if (mainPw != null) mainPw.Dispose();

        // 策略2：如果定位到真正的 3D 视口窗口，使用 PrintWindow + PW_RENDERFULLCONTENT
        if (source == "viewport") {
            Bitmap pw = CaptureWindowDirect(viewportHwnd, 2);
            if (pw != null && !IsMostlyBlack(pw, 10)) {
                Console.WriteLine("DEBUG using PrintWindow viewport {0}x{1}", pw.Width, pw.Height);
                return pw;
            }
            if (pw != null) pw.Dispose();
        }

        // 策略3：从屏幕复制目标区域（需要 PowerMill 在最前面）
        Bitmap screen = CaptureScreenRegion(targetRc);
        if (screen != null && !IsMostlyBlack(screen, 10)) {
            Console.WriteLine("DEBUG using screen capture {0}x{1}", screen.Width, screen.Height);
            return screen;
        }
        if (screen != null) screen.Dispose();

        Console.WriteLine("DEBUG all capture strategies failed or black");
        return null;
    }
}
'@
            Add-Type -TypeDefinition $csSource -ReferencedAssemblies @('System.Drawing.dll')

            try {
                # 确定用于截图的窗口句柄：优先 MainWindowHandle，无效时按进程+标题查找
                $hWnd = $pmProcess.MainWindowHandle
                Write-Host "DEBUG process=$($pmProcess.ProcessName) pid=$($pmProcess.Id) mainHandle=$hWnd"
                $testRc = New-Object PMWindowCapture+RECT
                $handleValid = $false

                # 若句柄有效但窗口最小化，先尝试恢复，避免误判为无效
                if ($hWnd -ne [IntPtr]::Zero -and [PMWindowCapture]::IsIconic($hWnd)) {
                    [PMWindowCapture]::ShowWindowAsync($hWnd, [PMWindowCapture]::SW_SHOWNORMAL) | Out-Null
                    Start-Sleep -Milliseconds 500
                }

                if ($hWnd -ne [IntPtr]::Zero -and [PMWindowCapture]::IsWindowVisible($hWnd) -and [PMWindowCapture]::GetClientRect($hWnd, [ref]$testRc)) {
                    $cw = $testRc.Right - $testRc.Left
                    $ch = $testRc.Bottom - $testRc.Top
                    if ($cw -gt 100 -and $ch -gt 100) { $handleValid = $true }
                    Write-Host "DEBUG mainHandle client=${cw}x${ch} visible=$([PMWindowCapture]::IsWindowVisible($hWnd)) valid=$handleValid"
                }
                if (-not $handleValid) {
                    $found = [PMWindowCapture]::FindPowerMillWindow([uint32]$pmProcess.Id)
                    Write-Host "DEBUG fallback found=$found"
                    if ($found -ne [IntPtr]::Zero) {
                        $hWnd = $found
                        $handleValid = $true
                    }
                }
                if (-not $handleValid) {
                    $result = @{ success = $false; error = '无法定位 PowerMill 可视窗口，请确保窗口未最小化' }
                    break
                }

                # 将 PowerMill 强制置前并临时置顶，确保 BitBlt 屏幕捕获时不被遮挡，
                # 且 F6 快捷键能发送到 PowerMill 主窗口。
                $madeTopmost = $false
                try {
                    [PMWindowCapture]::ForceForegroundWindow($hWnd)
                    [PMWindowCapture]::SetWindowPos($hWnd,
                        [PMWindowCapture]::HWND_TOPMOST, 0, 0, 0, 0,
                        [PMWindowCapture]::SWP_NOMOVE -bor [PMWindowCapture]::SWP_NOSIZE -bor [PMWindowCapture]::SWP_SHOWWINDOW) | Out-Null
                    $madeTopmost = $true
                    Start-Sleep -Milliseconds 400
                } catch {}

                # 定位 MDI 客户区窗口与真正的 3D 视口窗口
                $mdiClientHwnd = [PMWindowCapture]::FindMDIClient($hWnd)
                $viewportHwnd = [PMWindowCapture]::FindViewportWindow($hWnd)
                Write-Host "DEBUG mdiClientHwnd=$mdiClientHwnd viewportHwnd=$viewportHwnd"

                # 截图前先隐藏刀具，避免 F6 自适应时以巨大的刀具为边界，
                # 导致工件被缩得很小或超出画面。
                # 临时关闭错误对话框，避免不支持命令时反复弹窗。
                Invoke-PMMacro $pm 'DIALOGS ERROR OFF'
                # 2027 中通过宏命令逐个隐藏/恢复刀具会弹窗或报错，
                # 改为直接操作 COM 对象的 Drawn 属性（如果支持）。
                $hiddenTools = @()
                try {
                    foreach ($t in $pm.Project.Tools) {
                        try {
                            $n = Get-PMProperty $t 'Name' ''
                            if (-not $n) { continue }
                            Write-Host "DEBUG tool name=$n type=$($t.GetType().Name)"
                            # 尝试多个可能控制刀具显示的属性
                            $hidden = $false
                            foreach ($prop in @('Drawn','Visible','Displayed','Shaded')) {
                                try {
                                    $val = $t.$prop
                                    Write-Host "DEBUG   property $prop = $val (type=$($val.GetType().Name))"
                                    if ($val -is [bool] -and $val) {
                                        $t.$prop = $false
                                        $hidden = $true
                                    }
                                } catch {
                                    Write-Host "DEBUG   property $prop error: $($_.Exception.Message)"
                                }
                            }
                            if ($hidden) { $hiddenTools += $n }
                        } catch {
                            Write-Host "DEBUG tool hide error: $($_.Exception.Message)"
                        }
                    }
                    Write-Host "DEBUG hidden tools count=$($hiddenTools.Count)"
                    Start-Sleep -Milliseconds 400
                } catch {}

                # 调整视图使模型完整充满视口：PowerMill 2027 中 F6 为"适应窗口"快捷键。
                # 主窗口已在最前，这里把键盘焦点切到真正的 3D 视口子窗口，
                # 确保 F6 被视口处理。
                try {
                    if ($viewportHwnd -ne [IntPtr]::Zero) {
                        [PMWindowCapture]::SetFocus($viewportHwnd) | Out-Null
                        Start-Sleep -Milliseconds 300
                    }
                    [PMWindowCapture]::keybd_event(0x75, 0, 0, 0)
                    [PMWindowCapture]::keybd_event(0x75, 0, 0x2, 0)
                    Start-Sleep -Milliseconds 600
                    # 再按一次 F6，确保视图完全适应
                    [PMWindowCapture]::keybd_event(0x75, 0, 0, 0)
                    [PMWindowCapture]::keybd_event(0x75, 0, 0x2, 0)
                    Start-Sleep -Milliseconds 800
                } catch {}

                $bitmap = [PMWindowCapture]::CaptureClient($hWnd, $mdiClientHwnd, $viewportHwnd)
                if ($null -eq $bitmap) {
                    $result = @{ success = $false; error = '无法获取 PowerMill 客户区尺寸' }
                    break
                }
                $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
                $width = $bitmap.Width
                $height = $bitmap.Height
                $bitmap.Dispose()
            } catch {
                $result = @{ success = $false; error = "Screenshot failed: $($_.Exception.Message)" }
                break
            } finally {
                # 截图完成后取消窗口置顶并恢复 UI 元素
                if ($madeTopmost) {
                    try {
                        [PMWindowCapture]::SetWindowPos($hWnd,
                            [PMWindowCapture]::HWND_NOTOPMOST, 0, 0, 0, 0,
                            [PMWindowCapture]::SWP_NOMOVE -bor [PMWindowCapture]::SWP_NOSIZE) | Out-Null
                    } catch {}
                }
                # 恢复刀具显示
                try {
                    foreach ($n in $hiddenTools) {
                        try {
                            # 通过名称查找刀具对象并恢复显示属性
                            $toolObj = $null
                            foreach ($t in $pm.Project.Tools) {
                                if ((Get-PMProperty $t 'Name' '') -eq $n) {
                                    $toolObj = $t
                                    break
                                }
                            }
                            if ($null -ne $toolObj) {
                                foreach ($prop in @('Drawn','Visible','Displayed','Shaded')) {
                                    try {
                                        $val = $toolObj.$prop
                                        if ($val -is [bool] -and -not $val) {
                                            $toolObj.$prop = $true
                                            break
                                        }
                                    } catch {}
                                }
                            }
                        } catch {}
                    }
                } catch {}
                Invoke-PMMacro $pm 'DIALOGS ERROR ON'
                try {
                    Set-PMUIVisibility $pm $true
                } catch {}
            }

            # 验证文件
            if (Test-Path $OutputPath) {
                $fileInfo = Get-Item $OutputPath
                if ($fileInfo.Length -gt 0) {
                    $result = @{
                        success  = $true
                        path     = $OutputPath
                        size     = $fileInfo.Length
                        width    = $width
                        height   = $height
                        modified = $fileInfo.LastWriteTime.ToString('o')
                        view     = $View
                    }
                } else {
                    $result = @{ success = $false; error = 'Screenshot file is empty' }
                }
            } else {
                $result = @{ success = $false; error = "Screenshot file not created: $OutputPath" }
            }
        }

        # ---- 执行任意宏命令 ----
        'execute' {
            if ([string]::IsNullOrWhiteSpace($Command)) {
                $result = @{ success = $false; error = '必须指定 -Command 参数' }
                break
            }
            $output = Invoke-PMMacro $pm $Command
            $result = @{
                success = $true
                output  = if ($null -ne $output) { $output.Trim() } else { '' }
                command = $Command
            }
        }
    }
} catch {
    $result = @{
        success = $false
        error   = "执行 $Action 时出错: $($_.Exception.Message)"
    }
} finally {
    # 释放 COM 对象
    if ($null -ne $pm) {
        [Runtime.InteropServices.Marshal]::ReleaseComObject($pm) | Out-Null
    }
}

Write-Output ($result | ConvertTo-Json -Depth 10 -Compress)
