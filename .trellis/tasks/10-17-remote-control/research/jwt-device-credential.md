# 设备凭证改造：OAuth 式一次性码 + JWT

> 决策时间：阶段 5 完成后
> 状态：**已实施**（`tokens.js` / `jwt-key.js` / `auth.js` / `store.js` / `pairing-route.js`；测试见 `tests/tokens.test.mjs`、`tests/jwt-key.test.mjs`、`tests/gateway-credential-leak.test.mjs`）

## 1. 需求

用户要求：**授权流程类似 OAuth 的一次性验证码，然后签发 JWT，JWT 里保留必要信息。**

已确认的关键取舍：**JWT + 服务端吊销表**。理由：纯无状态 JWT 无法满足 PRD 约束 5「吊销必须即时生效」。

## 2. 当前实现（要替换的部分）

```
配对: pairId + code -> devices.json 存 sha256(32字节随机令牌) -> Set-Cookie: dsh-rc-device=<随机串>
鉴权: hash(令牌) -> 线性扫描 devices 表 -> 命中且未吊销则放行
```

问题：令牌是不透明随机串，不含任何信息；每次鉴权都要读表（虽有节流，但语义上仍需查找）。

## 3. 目标设计

### 3.1 授权流程（OAuth 授权码形态）

```
① 桌面面板 POST /remote-control/api/pairing
   -> { pairId, code, expiresAt }        code 一次性、120s TTL

② 手机 GET /remote-control/pair#<pairId>:<code>
   -> 页面读 location.hash（片段不进服务端日志）

③ 手机 POST /remote-control/pair  { pairId, code }
   -> 校验 code（一次性、常量时间、失败计数）
   -> 签发 JWT
   -> Set-Cookie: dsh-rc-jwt=<JWT>; HttpOnly; SameSite=Lax; Path=/; Max-Age=...
   -> 303 到 /

④ 后续每个请求：验签 + 查吊销表 -> 放行
```

### 3.2 JWT 载荷（只放必要信息，不放敏感内容）

```jsonc
{
  "iss": "dsh-remote-control",
  "sub": "dev_xxx",           // 设备 id，吊销表的键
  "aud": "dsh-gateway",
  "iat": 1760000000,
  "exp": 1760000000 + N,
  "jti": "<随机>",            // 供将来做单令牌吊销
  "name": "iPhone · Safari"   // 设备名，便于面板/审计显示，非敏感
}
```

**不放**：内层 `dsh-auth-*` 凭证、令牌哈希、配对码、IP。
`sub` 是唯一用于鉴权的声明；其余是便利信息，**校验时不得信任 JWT 里的 name**（以 devices.json 为准，防止旧 JWT 显示过期名字）。

### 3.3 签名

- 算法：**HS256**（HMAC-SHA256），固定算法，**校验时拒绝 `alg: none` 与任何非 HS256**（经典 JWT 漏洞）。
- 密钥：32 字节随机，存 `~/.dsh/remote-control/jwt-key`，权限 0600（Windows no-op，同 `store.js` 的处理）。
- 密钥缺失时**生成并持久化**；生成失败则拒绝启用远程能力（不能静默用内存密钥，否则重启后所有设备失效且无提示）。
- 不用非对称算法：本地单进程，无第三方验签方，RSA/EC 只增加复杂度。

### 3.4 吊销

- `devices.json` 里保留 `revokedAt`。
- 网关启动时把已吊销的 `sub` 读进内存 `Set`；吊销时同步写入该 Set 并关闭活动 socket（走 `gateway.revokeDevice`）。
- 每个请求：验签通过后查这个 Set。**一个内存 Set 查找**，不是磁盘读。
- 这样既保留 JWT 的「不用为鉴权读表」，又满足「吊销即时生效」。

### 3.5 与现有代码的接缝

| 现有 | 改造 |
|---|---|
| `tokens.js` `createDeviceToken()` 生成随机串 | 改为 `signDeviceToken(claims)` 签发 JWT；保留 `hashToken`/`sameTokenHash` 供内部其他用途 |
| `store.findActiveDeviceByTokenHash(hash)` | 改为 `findActiveDeviceById(id)`（JWT 的 `sub`） |
| `wire.deviceCookie(name, value)` | Cookie 名改 `dsh-rc-jwt`，值改 JWT |
| `DEVICE_COOKIE_NAME = 'dsh-rc-device'` | **保持旧名不变更名**会导致老设备全部掉线；建议：新增 `JWT_COOKIE_NAME`，过渡期两者都接受 |
| `gateway/auth.js` 第 2 步 | 改为「解析并验签 JWT」，失败仍 401 |

### 3.6 迁移

`devices.json` 里已有的 `tokenHash` 字段：
- 保留字段（不破坏 `version: 1` 的读取），但新签发的设备不再写它。
- 老设备（有 `tokenHash` 无 JWT）在过期后自然需要重新配对。**MVP 不做自动迁移**——设备表通常只有个位数，重新配对成本可接受，且避免了「用旧哈希换新 JWT」的信任链问题。

## 4. 测试要求

- 验签：正确通过；篡改 payload 失败；篡改签名失败；`alg: none` 被拒；过期被拒；错误的 issuer/audience 被拒。
- 签发→使用闭环：配对拿到的 JWT 能直接通过网关鉴权。
- 吊销：吊销后同一 JWT 立即 401，且活动 socket 被关闭。
- 密钥：文件缺失时生成并持久化；权限 0600（Windows 不抛错）；损坏的密钥文件拒绝启动。
- 一次性码：重复兑换失败；过期失败；5 次失败锁定；换 pairId 不能绕过源级预算。
- **不得**在任何日志/审计/响应里出现 JWT 值或密钥。

## 5. 安全边界更新（README 必须写）

- JWT 在 Cookie 里，未加 `Secure`（局域网 HTTP）。
- JWT 泄露 = 该设备的全部权限，直到过期或被吊销。
- 签名密钥在磁盘上（0600），任何能读该文件的本地进程都能伪造设备身份——这与「本机已被攻破」同级。
