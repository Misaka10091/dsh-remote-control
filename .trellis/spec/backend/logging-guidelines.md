# Logging Guidelines

> How logging is done in this project.

---

## Overview

两种日志，职责不同，**不要互相替代**：

| 用途 | 落地形式 | 内容 |
|---|---|---|
| 运行诊断 | `ctx.logger`（Cordis 注入） | 启动/降级/上游异常 |
| 操作审计 | `~/.dsh/remote-control/audit-YYYY-MM-DD.jsonl` | 远程设备做了什么 |

诊断日志是给人排查的，审计是给用户对账的。审计要求可导出、可保留 30 天，所以不能只写诊断日志。

---

## Log Levels

用 `ctx.logger`，不 `console.log`：

- `logger.info` — 生命周期事件：网关开始监听 `<port>`、设备配对成功、设备被吊销。
- `logger.warn` — 可降级但需注意：`ctx.connection` 不可用导致内层凭证缺失、上游 401 后重兑成功、审计清理删除了文件。
- `logger.error` — 需要人介入：端口占用启动失败、`devices.json` 损坏、内层凭证重兑仍失败。
- `logger.debug` — 逐请求的路由与判定结果。默认不开。

启动成功必须打印**恰好一行**，形如：

```
[remote-control] gateway listening on 0.0.0.0:3090 (upstream 127.0.0.1:19387)
```

这是阶段 0 的验收依据。

---

## Structured Logging

诊断日志用自由文本 + 关键值内联，不引入结构化日志库。示例：

```js
ctx.logger.info(`[remote-control] device paired: ${device.id} (${device.name})`)
```

审计日志**必须是严格 JSONL**，一行一个 JSON 对象，字段固定：

```jsonc
{ "ts": "2026-10-17T03:04:43.000Z", "event": "send_message", "deviceId": "dev_x", "ip": "192.168.1.7", "meta": {} }
```

- `ts` 一律 ISO-8601 UTC（`new Date().toISOString()`）。
- `event` 取值封闭集合：`pair`、`connect`、`disconnect`、`send_message`、`stop_task`、`approval_answer`、`revoke`、`unknown`。
- `meta` 只放标识符（如 `sessionId`），**不放正文**。

---

## What to Log

- 网关监听/停止，及上游目标。
- 设备配对、吊销（含来源 IP）。
- 上游返回 401 且触发内层凭证重兑。
- 可选能力降级（`ctx.connection` 缺失等）。

---

## What NOT to Log

绝对禁止出现在任何日志（诊断与审计都一样）：

- 设备令牌明文，及其 sha256 摘要。
- 内层 `dsh-auth-*` Cookie 的值。
- 配对码明文（配对 URL 的 `#` 片段不进服务端，也不得被记进日志）。
- 消息正文、工具参数、文件内容。
- 请求体全文。

审计只记「谁、什么时候、做了什么动作」，不记「做了什么内容」。
