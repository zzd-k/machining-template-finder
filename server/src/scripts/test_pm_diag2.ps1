# PowerMill GetParameterXML 诊断
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    $pm = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerMILL.Application')
    Write-Output "[OK] 连接成功"
} catch {
    Write-Output "[FAIL] 连接失败"
    exit 1
}

# 测试不同参数格式的 GetParameterXML
$params = @(
    'PROJECTPATH',
    'projectpath',
    'ProjectPath',
    'PROJECTNAME',
    'projectname',
    'units',
    'UNITS',
    'Units',
    'ENTITY("toolpath","").name',
    "entity('toolpath','').name",
    'entity("toolpath","")',
    "entity('toolpath','')",
    'PROJECT',
    'project',
    'Project.Name',
    'Version',
    'version',
    'VERSION'
)

Write-Output "`n--- GetParameterXML 测试 ---"
foreach ($p in $params) {
    try {
        $result = $pm.GetParameterXML($p)
        $display = if ($result) { $result.Substring(0, [Math]::Min(200, $result.Length)) } else { '(empty)' }
        Write-Output "[$p] => $display"
    } catch {
        Write-Output "[$p] => ERROR: $($_.Exception.Message)"
    }
}

# 测试 DoCommandEx 不同参数数量
Write-Output "`n--- DoCommandEx 参数测试 ---"
$cmd = 'PRINT VALUE PROJECTPATH'

# 2参数: string, ref string
try {
    $output = ''
    $pm.DoCommandEx($cmd, [ref]$output)
    Write-Output "2参数(ref string): output='$output'"
} catch {
    Write-Output "2参数(ref string): FAIL - $($_.Exception.Message)"
}

# 2参数: string, object
try {
    $output = New-Object object
    $pm.DoCommandEx($cmd, [ref]$output)
    Write-Output "2参数(ref object): output='$output'"
} catch {
    Write-Output "2参数(ref object): FAIL - $($_.Exception.Message)"
}

# 3参数
try {
    $output = ''
    $status = 0
    $pm.DoCommandEx($cmd, [ref]$output, [ref]$status)
    Write-Output "3参数: output='$output' status='$status'"
} catch {
    Write-Output "3参数: FAIL - $($_.Exception.Message)"
}

# 检查 Project 是否为 null
Write-Output "`n--- Project 检查 ---"
try {
    $proj = $pm.Project
    if ($null -eq $proj) {
        Write-Output "Project 为 null (未打开项目)"
    } else {
        Write-Output "Project 类型: $($proj.GetType().Name)"
        try { Write-Output "Project.Name: '$($proj.Name)'" } catch { Write-Output "Project.Name: FAIL" }
    }
} catch {
    Write-Output "Project 属性: FAIL - $($_.Exception.Message)"
}

# 检查 Version
Write-Output "`n--- Version ---"
try {
    $ver = $pm.Version
    Write-Output "Version: '$ver'"
} catch {
    Write-Output "Version: FAIL - $($_.Exception.Message)"
}

[Runtime.InteropServices.Marshal]::ReleaseComObject($pm) | Out-Null
Write-Output "`n=== 完成 ==="
