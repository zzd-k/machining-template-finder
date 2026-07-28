// 空签名脚本：明确告诉 electron-builder 不要对 Windows 可执行文件进行代码签名
// 避免在无证书环境中卡在校验/自签名步骤
exports.default = async function () {
  return null
}
