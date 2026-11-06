# Paseo for Chrome

一个极简的 Chrome（MV3）侧边栏扩展，用官方 SDK [`@getpaseo/client`](https://www.npmjs.com/package/@getpaseo/client) 连接 Paseo daemon（host）。

## 功能
- 通过 WebSocket 连接 host（支持密码），会自动重连，并记住上次的地址
- 列出 agent，状态实时更新
- 新建 agent（选择 provider/model、cwd、prompt）
- 查看 agent 时间线（实时），发送消息
- 批准或拒绝权限请求

## 构建与安装
```bash
npm install
npm run build        # 输出到 dist/
```
打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/` 目录。点击工具栏图标即可打开侧边栏。

## 连接方式
1. **官方配对链接（推荐）**：在 host 上运行 `paseo daemon pair`，把输出的 `https://app.paseo.sh/#offer=…` 粘贴到扩展里，点击「连接」。连接经 relay 转发，端到端加密，不需要配置 Origin。也支持 `relay://…` 格式的连接 URI。
2. **直连**：输入 `ws://host:6767/ws`，需要按下面的说明放行扩展的 Origin。

## 允许扩展的 Origin（仅直连需要）
daemon 会校验 WebSocket 的 `Origin`。扩展的请求来自 `chrome-extension://<扩展ID>`，默认会被拒绝（403 Origin not allowed）。
把这个 origin 加到 host 的 `~/.paseo/config.json`，然后重启 daemon：

```json
{ "daemon": { "cors": { "allowedOrigins": ["chrome-extension://<扩展ID>"] } } }
```
连接页底部的「连接被拒绝?」里会显示需要填入的准确值。

## License
[Apache-2.0](./LICENSE)
