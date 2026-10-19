# Database Guidelines

> 本项目**没有数据库**。此文件说明为什么，以及数据实际存在哪里。

---

## Overview

远程控制插件只持久化两类数据，都是本地文件，不引入任何数据库、ORM 或迁移框架：

| 数据 | 位置 | 格式 |
|---|---|---|
| 设备表与设置 | `~/.dsh/remote-control/devices.json` | 单个 JSON 文档 |
| 操作审计 | `~/.dsh/remote-control/audit-YYYY-MM-DD.jsonl` | 按天分文件，一行一事件 |

选型理由：设备数量是人手可数的（个位数到几十），单进程无并发写者，没有查询需求。引入数据库只会增加安装负担与升级面。

---

## 存储约定

- **权限 0600**（POSIX）。Windows 上 chmod 是 no-op，不得因此报错。
- **原子写**：写临时文件 → `fsync` → `rename` 覆盖。禁止直接 `writeFile` 覆盖目标文件（进程中断会留下半个 JSON）。
- **读取失败必须显式报错**：文件存在但 JSON 解析失败 → 抛 `store/corrupt`，并拒绝启用远程能力。不得当成"空设备表"静默继续——那会让用户以为设备都还在，或以为鉴权在生效其实没有。
- **版本字段**：顶层 `version` 用于将来升级。读到更高版本的 `version` 必须拒绝启动并提示，不要"尽力解析"。
- **不持久化任何凭证。** 设备凭证是设备自己持有的 HS256 JWT（`tokens.js` + `jwt-key.js`），文件里没有任何可供攻击者对着猜的东西——这比「只存摘要」更强。旧文件里的 `tokenHash` 字段会被读取、校验并原样保留（`store.js` 的 legacy 路径），但**没有代码拿哈希做鉴权**，所以不需要改写迁移：它留在原位，只是一个再也无法通过鉴权的旧字段。

## Schema

完整结构见 `design.md` §5。要点：

```jsonc
{
  "version": 1,
  "devices": [
    {
      "id": "dev_xxx",            // 设备 id：行主键，同时也是 JWT 的 sub
      "name": "iPhone · Safari",
      "ua": "...",
      "createdAt": "...",
      "lastSeenAt": "...",
      "revokedAt": null,
      "capabilities": null      // 预留，MVP 不用（PRD D6）
    }
  ],
  "settings": { "enabled": false, "port": 3090 }
}
```

## Query Patterns

没有查询层。设备查找就是 `store.findDeviceById(id)` 里的 `Array.prototype.find`，按 `id` 线性扫描——设备量级（个位数到几十）下这是正确的选择，不要提前优化成 Map（会引入两份状态同步的问题）。`tokenHash` 上的查找已随 JWT 改造消失，不要再加回来。

## Migrations

没有迁移框架。升级靠 `version` 字段：

- `version === 1`：当前格式，直接读。
- `version > 1`：拒绝启动，错误码 `store/version-unsupported`，提示用户升级插件。
- 将来加字段时：只做向后兼容的新增字段（老文件缺字段按默认值补齐），不做原地改写迁移。

## 审计文件

- 一天一个文件，文件名 `audit-YYYY-MM-DD.jsonl`（**UTC** 日期）。
- 追加写，不重写。
- 保留 30 天：启动时清理一次，之后每日清理一次。
- 清理只删除过期文件，不改动当天文件。

## Common Mistakes

- **直接覆盖写 `devices.json`。** 崩溃会毁掉整张设备表，所有已配对设备一起失效。
- **把损坏文件当空表。** 见上，这是静默的安全降级。
- **在文件名里用本地时区。** 审计按 UTC 分天，否则跨时区导出会缺/重。
- **审计里写正文。** 违反 PRD D5，且导出功能会把隐私一起导出去。
