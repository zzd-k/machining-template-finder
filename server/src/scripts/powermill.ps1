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
    [string]$OutputPath = ''
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
    try {
        $pm.Execute($cmd) | Out-Null
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

# ========== 主逻辑 ==========

$pm = Connect-PowerMill

if ($null -eq $pm) {
    $result = @{
        success = $false
        error   = '无法连接 PowerMill，请确保 PowerMill 已启动并已打开项目'
    }
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 1
}

try {
    switch ($Action) {

        # ---- 读取当前项目状态 ----
        'status' {
            # 优先使用 GetParameterXML 获取参数值（推荐方式）
            $projectName = Get-PMParameter $pm 'PROJECTNAME'
            $projectPath = Get-PMParameter $pm 'PROJECTPATH'
            $units       = (Get-PMParameter $pm 'units').ToUpper()

            # 如果 GetParameterXML 失败，降级到 DoCommandEx
            if ([string]::IsNullOrWhiteSpace($projectPath)) {
                $projectPath = "$(Invoke-PMMacro $pm 'PRINT VALUE PROJECTPATH')".Trim()
            }
            if ([string]::IsNullOrWhiteSpace($projectName)) {
                $projectName = "$(Invoke-PMMacro $pm 'PRINT VALUE PROJECT NAME')".Trim()
            }
            if ([string]::IsNullOrWhiteSpace($units)) {
                $units = "$(Invoke-PMMacro $pm 'PRINT VALUE units')".Trim().ToUpper()
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
        'screenshot' {
            if ([string]::IsNullOrWhiteSpace($OutputPath)) {
                $result = @{ success = $false; error = '必须指定 -OutputPath 参数' }
                break
            }
            # 确保目录存在
            $dir = Split-Path $OutputPath -Parent
            if ($dir -and !(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

            # PowerMill 截图宏命令（路径需用正斜杠或双反斜杠）
            $pmPath = $OutputPath -replace '\\', '/'
            Invoke-PMMacro $pm "EXPORT IMAGE FILE '$pmPath'"

            Start-Sleep -Milliseconds 500  # 等待文件写入

            if (Test-Path $OutputPath) {
                $fileInfo = Get-Item $OutputPath
                $result = @{
                    success  = $true
                    path     = $OutputPath
                    size     = $fileInfo.Length
                    modified = $fileInfo.LastWriteTime.ToString('o')
                }
            } else {
                $result = @{ success = $false; error = '截图导出失败，文件未生成' }
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
