# 执行计划：远程控制插件

对应 `prd.md`（需求）与 `design.md`（设计）。按阶段推进，每阶段有独立验收点。

## 阶段 0：工程骨架

- [ ] `package.json`：包名 `@misaka10091/dsh-remote-control`、`type: module`、`dsh.bundle.patch`、`dsh.client.inject`、`files` 清单
- [ ] `dsh.plugin.json`：id `dsh-external/dsh-remote-control`、`contributes`
- [ ] `cordis.patch.yml`：bundle patch 插入行
- [ ] 目录骨架 `src/host/`、`src/client/`、`tests/`
- [ ] `.gitignore` 补充运行时目录
- **验收**：`dsh plugin --profile web add <path>` 可安装，启动后打印一行加载日志，无报错

## 阶段 1：设备存储与配对

- [ ] `src/host/store.js`：`devices.json` 读写、原子写、0600 权限
- [ ] `src/host/pairing.js`：配对码生成（8 位 base32）、TTL、一次性兑换
- [ ] `src/host/tokens.js`：令牌生成（32 字节）、sha256 哈希、`timingSafeEqual` 比对
- **验收**：单测覆盖——兑换成功、重复兑换失败、过期失败、令牌比对正确

## 阶段 2：网关 HTTP 侧

- [ ] `src/host/gateway/server.js`：自建 `http.Server`，可配置端口，`ctx.effect()` 清理
- [ ] `src/host/gateway/auth.js`：Cookie 解析、令牌校验、loopback 判定
- [ ] `src/host/gateway/origin.js`：Origin / Sec-Fetch-Site 校验，无 Origin 写请求拒绝
- [ ] `src/host/gateway/proxy.js`：上游转发，Host 改写，SSE/chunked 透传
- **验收**：curl 验证——无 Cookie 401、伪 Origin 403、带 Cookie 200 且内容与直连一致

## 阶段 3：网关 WebSocket 侧

- [ ] `src/host/gateway/wsproxy.js`：升级鉴权 + 双向帧透传
- [ ] 处理 `/api/remote.mux` 多路复用连接
- [ ] ping/pong 控制帧透传
- **验收**：远程浏览器能收到流式输出；断线后重连可用

## 阶段 4：管理 API 与审计

- [ ] `src/host/api.js`：`/remote-control/api/*`，仅 loopback
- [ ] `src/host/audit.js`：JSONL 追加、30 天清理、导出
- [ ] 路径前缀 → 动作映射（`send_message` / `stop_task` / `approval_answer`），无法识别记 `unknown`
- **验收**：管理接口从远程调用返回 403；审计文件正确轮转与清理

## 阶段 5：客户端 UI

- [ ] `src/client.js`：`window.__ModuleLoader__.load` 包装，注册侧边栏底部图标
- [ ] 设备面板：开关、端口、二维码、设备列表、吊销、审计导出
- [ ] 中英文案（`locale/`）
- **验收**：面板可完成一次完整配对；吊销后列表即时更新

## 阶段 6：验证与文档

- [ ] `tests/` 单测通过（`node --test`）
- [ ] 真机验证：手机扫码 → 打开会话 → 发消息 → 收流式 → 停止
- [ ] README（中英）：安装、使用、**安全边界**（局域网无 TLS、令牌等价完整控制权）
- [ ] CHANGELOG 首条记录
- [ ] `npm pack --dry-run` 产物完整

## 验证命令

```bash
npm test                 # 单测
npm run check:syntax     # node --check
npm pack --dry-run       # 产物检查
```

真机验证需在装有本插件的实例上进行，且**必须**验证：

1. 关闭开关时 `dsh web` 行为无变化
2. 未配对远程访问被拒
3. 配对后可操作同一会话
4. 吊销后立即失效
5. 审计记录完整且不含正文

## 回滚点

- 阶段 0 失败 → 直接删除，无副作用
- 阶段 2 完成但阶段 3 卡住 → 保留 HTTP 网关，WebSocket 降级为"不支持流式"，README 明示
- 任何阶段发现与 DSH 版本不兼容 → 停在该阶段，记录到 `research/`，不强行绕过

## 风险与对策

| 风险 | 对策 |
|---|---|
| 官方 WS 升级行为变化 | 代理不解析帧内容，只透传；升级失败时降级为不支持流式并记录 |
| 官方路径变更导致审计漏记 | 记 `unknown`，不耦合内部接口 |
| 局域网无 TLS | README 明确边界，推荐 Tailscale |
| 代理缓冲导致流式卡顿 | SSE 强制不缓冲，端到端验证 |
