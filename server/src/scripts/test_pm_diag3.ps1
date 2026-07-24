# 测试 GetParameterXML 返回值
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pm = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerMILL.Application')

# 测试 PROJECTPATH
$r = $pm.GetParameterXML('PROJECTPATH')
Write-Output "PROJECTPATH: Type=$($r.GetType().Name), IsString=$($r -is [string]), Value=[$r]"

# 测试 PROJECTNAME
$r2 = $pm.GetParameterXML('PROJECTNAME')
Write-Output "PROJECTNAME: Type=$($r2.GetType().Name), IsString=$($r2 -is [string]), Value=[$r2]"

# 测试 units
$r3 = $pm.GetParameterXML('units')
Write-Output "units: Type=$($r3.GetType().Name), IsString=$($r3 -is [string]), Value=[$r3]"

# 测试 PROJECTPATH 是否以 < 开头
$rTrim = "$r".Trim()
Write-Output "PROJECTPATH StartsWith<: $($rTrim.StartsWith('<'))"

# 测试 Project.Name
$r4 = $pm.GetParameterXML('Project.Name')
Write-Output "Project.Name: Type=$($r4.GetType().Name), Value=[$r4]"

[Runtime.InteropServices.Marshal]::ReleaseComObject($pm) | Out-Null
