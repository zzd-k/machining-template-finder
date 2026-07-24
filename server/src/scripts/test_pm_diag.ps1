# PowerMill COM 诊断脚本
# 测试不同方法获取命令输出

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Output "=== PowerMill COM 诊断 ==="

# 连接
try {
    $pm = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerMILL.Application')
    Write-Output "[OK] GetActiveObject 成功"
} catch {
    Write-Output "[FAIL] GetActiveObject 失败: $($_.Exception.Message)"
    try {
        $pm = New-Object -ComObject PowerMILL.Application
        Write-Output "[OK] New-Object 成功"
    } catch {
        Write-Output "[FAIL] New-Object 也失败: $($_.Exception.Message)"
        exit 1
    }
}

# 测试1: 列出 COM 对象类型
Write-Output "`n--- 类型信息 ---"
Write-Output "Type: $($pm.GetType().FullName)"

# 测试2: 尝试 DoCommandEx 单参数
Write-Output "`n--- 测试 DoCommandEx (单参数) ---"
try {
    $result = $pm.DoCommandEx('PRINT VALUE PROJECTPATH')
    Write-Output "返回值: $result (类型: $($result.GetType().Name))"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试3: 尝试 DoCommandEx 双参数
Write-Output "`n--- 测试 DoCommandEx (双参数 [ref]) ---"
try {
    $output = ''
    $pm.DoCommandEx('PRINT VALUE PROJECTPATH', [ref]$output)
    Write-Output "output: '$output'"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试4: 尝试 Execute
Write-Output "`n--- 测试 Execute ---"
try {
    $result = $pm.Execute('PRINT VALUE PROJECTPATH')
    Write-Output "返回值: $result (类型: $($result.GetType().Name))"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试5: 尝试 GetParameterXML
Write-Output "`n--- 测试 GetParameterXML ---"
try {
    $result = $pm.GetParameterXML('PROJECTPATH')
    Write-Output "返回值: $result (类型: $($result.GetType().Name))"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试6: 尝试 GetParameter
Write-Output "`n--- 测试 GetParameter ---"
try {
    $result = $pm.GetParameter('PROJECTPATH')
    Write-Output "返回值: $result (类型: $($result.GetType().Name))"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试7: 尝试 Project.Name
Write-Output "`n--- 测试 Project.Name ---"
try {
    $name = $pm.Project.Name
    Write-Output "返回值: '$name' (类型: $($name.GetType().Name))"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试8: 尝试 Project.Path
Write-Output "`n--- 测试 Project.Path ---"
try {
    $p = $pm.Project.Path
    Write-Output "返回值: '$p' (类型: $($p.GetType().Name))"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试9: 尝试 PrintOutput
Write-Output "`n--- 测试 PrintOutput 属性 ---"
try {
    $result = $pm.PrintOutput
    Write-Output "返回值: '$result'"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试10: 尝试 Output
Write-Output "`n--- 测试 Output 属性 ---"
try {
    $result = $pm.Output
    Write-Output "返回值: '$result'"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试11: 尝试 LastOutput
Write-Output "`n--- 测试 LastOutput 属性 ---"
try {
    $result = $pm.LastOutput
    Write-Output "返回值: '$result'"
} catch {
    Write-Output "[FAIL] $($_.Exception.Message)"
}

# 测试12: 先 Execute 再读 Output
Write-Output "`n--- 测试 Execute + Output ---"
try {
    $pm.Execute('PRINT VALUE PROJECTPATH')
    Start-Sleep -Milliseconds 500
    try {
        $result = $pm.Output
        Write-Output "Output: '$result'"
    } catch {
        Write-Output "Output 属性不存在: $($_.Exception.Message)"
    }
} catch {
    Write-Output "[FAIL] Execute 失败: $($_.Exception.Message)"
}

# 释放
[Runtime.InteropServices.Marshal]::ReleaseComObject($pm) | Out-Null
Write-Output "`n=== 诊断完成 ==="
