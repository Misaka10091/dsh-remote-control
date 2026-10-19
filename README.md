# @misaka10091/dsh-remote-control

为 `dsh web` 增加一层配对门控的远程接入：手机或局域网里的另一台电脑可以打开**同一个**会话，
附带一个设备管理面板和一份本地审计记录。

> **状态：6 个阶段完成 0–5。** 宿主侧每一块都已实现并测试：设备存储、配对码、签名的设备
> **JWT**、**HTTP 网关**（监听、鉴权、Origin 围栏、内层凭证、反向代理）、**WebSocket 升级代理**、
> 带审计的**管理 API**，以及网关端口上真正能兑换配对码的**配对流程**
> （`GET`/`POST /remote-control/pair`）。
>
> 阶段 6（真机验证——手机 → 打开配对链接 → 打开会话 → 发消息 → 收流 → 停止）是剩下的事，
> 它需要这套测试提供不了的硬件。以下所有内容都在真实网关、OS 分配的端口上验证过；
> 进度见[路线图](#路线图)。

## 为什么需要它

`dsh web` 绑定在 `127.0.0.1`，你一离开工位，agent 就变得既不可观测也无法干预。
社区方案要么把流量绕经外部中转（一个你不得不信任的第三方），要么让每台配对设备获得完整权限、
以后想收紧都没有边界。

这个插件选了另一条路：

- **官方 `dsh web` 端口始终留在回环**。插件自己开一个监听，作为*唯一*的远程入口。
- 未配对的请求在到达 DSH **之前**就被拒绝。
- 本机回环访问从不经过网关，所以未开启远程接入时，行为与原生 `dsh web` 完全一致。
- 网关就是一个纯鉴权反向代理。它不理解 DSH 内部，所以 DSH 升级不会把它弄坏。

## 配对一台设备

1. 打开设备面板（侧栏底部「远程连接」）。面板**顶部**是总开关与端口，
   下面四个 tab：**配对 / 接入 / 设备 / 审计**。在「配对」里选好接入地址
   （局域网网卡 IP，或你自己配置的公网地址），点**生成配对码**。
   宿主生成一个 8 位 base32 码，有效期 120 秒，按 `XXXX-XXXX` 分组显示并带复制按钮，
   旁边是同一个配对链接的**二维码**。
2. 用手机相机扫码，或在设备上打开链接
   `http://<lan-ip>:<port>/remote-control/pair#<pairId>:<code>`，
   或把码输入页面上的手动输入框。这对值放在 URL 的 **fragment** 里，
   浏览器从不把 fragment 发给服务器，所以配对码不会落进访问日志。
3. 网关返回一个自包含的小页面，由它在浏览器端读取 fragment，并把
   `{ pairId, code }` POST 回同一路径。
4. 成功后网关**签发 JWT**（HS256），载荷含 `iss`/`sub`/`aud`/`iat`/`exp`/`jti`/`name`，
   以 `303` 跳回 `/` 并下发 `Set-Cookie: dsh-rc-jwt=…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`，
   同时记一条 `pair` 审计。`sub` 就是设备 id，网关后续靠它查表。
5. 码错了会被拒绝，并记 `pair_failed`。码过期或已用过会被拒绝，但**不**记
   `pair_failed`——那是正常行为，一个用户学会忽略的信号等于没有信号。

配对码从不写日志、不进审计、不落盘。没有 fragment 时，页面显示手动输入 `<pairId>:<code>` 的输入框。

> **二维码是手写的，且只做 byte 模式。** 没有为此引入依赖：编码器（byte 模式、纠错等级 M、
> 版本 1–15、掩码按 N1–N4 罚分选择）就是客户端半边里的普通 JavaScript。
> 它用 6 段文本 × 8 个掩码、外加 8 组自动版本/掩码，与 node-qrcode（**开发期**工具，
> 不是依赖）逐位比对，并用一个独立解码器回读了 v1–v11 的输出。两点后果值得知道：
>
> - 它不会把链接拆成数字段 / 字母数字段 / 字节段，所以符号可能比理论最小值大一到两个版本。
>   可预测、可验证，比最小更重要。
> - 符号永远是浅底深点，深色主题下也一样。它用的是设计 token 里**不随主题翻转**的那一组
>   （从不写死颜色），因为跟随主题的那一对会在深色主题下把符号反相，而有些扫码器拒绝
>   浅色点深色底的码。四模块静区是几何的一部分，随符号缩放，不会在最小的符号上消失。
>
> 超过 v15-M 容量的链接（412 字节）会给出提示，并保留文本码与链接——**绝不截断**。
> 另外：**还没有任何真机扫过这个码**，自动化验证是「参考编码器 + 独立解码器」，不是摄像头。
> 「接入」tab 只管公网地址簿（增、删、备注、标出使用中）；「审计」tab 除了计数与导出，
> 还能看最近的事件明细，并按动作筛选。

> **从早期版本升级：所有已配对设备都必须重新配对。**
>
> 设备凭证过去是 32 字节随机串，用 `devices.json` 里的 `sha256` 摘要比对；现在是签名的 JWT，
> cookie 名也从 `dsh-rc-device` 变成 `dsh-rc-jwt`。**不接受**旧 cookie 名：多接受一个
> cookie 名，就等于在唯一那处鉴权决定上多开一条代码路径，而它存的值本来也不是 JWT 校验器
> 能检查的东西。这里**故意不做自动迁移**——把旧哈希换成新 JWT 会是一条没人设计过的信任链
> （`research/jwt-device-credential.md` §3.6）。打开面板，把每台设备重新配对一次即可；
> 设备表里的行、名字和历史都保留。

## 凭据是怎么工作的

```
配对：  一次性码  →  POST /remote-control/pair  →  签名的 JWT 写进 HttpOnly cookie
鉴权：  验 JWT（HS256、iss、aud、exp）  →  用 `sub` 查设备表  →  查吊销集合
```

这是一条 **OAuth 形状**的流程：用短命的一次性码换一个携带网关所需声明的 bearer 凭证。
两件东西让它成立，缺一不可：

| 组成 | 它回答什么 | 位置 |
|---|---|---|
| 签名的 JWT | 「这是哪台设备，且不用扫哈希表？」 | `src/host/tokens.js` |
| 服务端吊销集合 | 「它签出来之后有没有被吊销？」 | `src/host/gateway/server.js` |

**纯无状态**的 JWT 满足不了约束 5（吊销必须即时生效）：一经签发，它到 `exp` 之前都有效，
只有服务端的列表能提前结束它。所以 JWT 里带 `sub`，网关维护一个已吊销 id 的 `Set`，
启动时从 `devices.json` 填充，由 `gateway.revokeDevice` 更新。每个请求的代价是一次 `Set` 查找，
**不是**一次磁盘读。

三个细节是承重的：

- **只接受 HS256，且 header 是比对而不是信任。** 从令牌里读 `alg` 再照办，就是经典的算法混淆漏洞。
  `alg: none`、`HS512`、`RS256`，以及小写拼写，全部在任何 HMAC 计算之前拒绝。
  `tests/tokens.test.mjs` 为每一种都钉了断言。
- **名字从存储里读，绝不从令牌里读。** JWT 是快照：否则在面板里改过名的设备会一直自称旧名字，
  直到它重新配对。
- **载荷里没有敏感数据。** JWT 是签名不是加密，所以设备状态只存在于 `devices.json`。
  不放内层凭证、不放令牌摘要、不放配对码、不放地址。

## 安装

```bash
dsh plugin --profile <name> add @misaka10091/dsh-remote-control
```

`dsh.bundle.patch` 声明会插入一条 loader 行（`id: remote-control`），不需要改 profile 文件。
客户端半边通过 `exports["./client"]` 提供，由浏览器 boot 图挂载。

要装本地 checkout 而不是 registry 上的包：

```bash
dsh plugin --profile <name> add link:/absolute/path/to/dsh-remote-control
```

> `desktop` profile 由 Electron 应用托管，会拒绝 CLI 插件命令。验证安装请用 CLI profile（`web`）。

## 安全边界（务必读）

这是 MVP，下面这些限制是**刻意的**。写出来而不是藏起来，因为它们决定这个插件是否适合你。

1. **没有传输加密。** 网关在局域网上说的是明文 HTTP，同一网段的被动监听者可以读到会话流量。
   要 TLS 就在前面放自己的反向代理，或用 Tailscale（或类似的私有组网）——插件事先不内置任何一种。
2. **设备令牌就是完整控制权。** 所有配对设备等价：还没有按设备的能力白名单（PRD D6）。
   数据模型和判定点给它留了位置，MVP 不实现。
3. **`SameSite=Lax` + Origin 校验能挡住跨站写**，包括来自其他源恶意页面的请求。它们**挡不住**
   同站 XSS，也挡不住已经在主机上运行的恶意程序。
4. **吊销只面向未来。** 吊销一台设备会拒绝它的新请求并关闭它的在线连接，不会撤销已经做完的动作。
5. **关掉就等于消失。** 关闭插件（或杀掉进程）会关闭监听，不留下任何端口。
6. **内层凭证从不离开服务器。** 网关必须向官方端口出示一个 `dsh-auth-*` cookie
   （官方端口连回环请求也鉴权）。那个 cookie 等价于整台 DSH 实例的完整访问权，
   所以它只存在于「网关 → 上游」这一跳，从不发给客户端、从不写日志、从不进审计。
7. **本机流量不在网关鉴权。** 同时满足「回环 socket」与「回环 `Host`」的请求免配对，
   这是桌面浏览器与 CLI 工具还能工作的原因。两半必须同时成立：只有回环 socket 正是
   DNS rebinding 能造出来的东西。
8. **猜码是限速的，不是不可能的。** 5 次错码销毁一个配对码；每分钟 20 次错码独立封禁一个来源地址，
   所以换 `pairId` 也重置不了额度。两条限制都不能让「泄露后猜中」变成不可能——
   它们只是让无效搜索变得又吵又慢。
9. **配对路由按设计就是无 cookie 可达的。** 正在配对的设备还没有凭证，所以
   `GET`/`POST /remote-control/pair` 是下面那条请求流水线唯一不拦的路径。
   它们仍然过 Origin 围栏、仍然在开关关闭时被拒、仍然受同一套暴力破解预算约束——
   并且它们从不进入代理、没有有效码就不会签发设备、也从不触碰 DSH。
   这个豁免只豁免凭证，别无其他。
10. **设备 cookie 不带 `Secure`。** 局域网传输是明文 HTTP，`Secure` cookie 根本不会被回传，
    于是配对看起来成功、下一次请求就失败。它是 `HttpOnly; SameSite=Lax`，
    这是在明文 HTTP 上还能工作的最强组合。
11. **泄露的 JWT 在该设备被吊销或过期前就是它的全部权限。** 令牌是 bearer 凭证：
    复制到 cookie 的人从局域网任何位置都能获得同样的访问，没有第二因子。
    它活 30 天，所以面板上的**吊销**按钮才是提前结束它的方式——而吊销是即时的
    （见下面的流水线），因为网关持有服务端吊销集合，而不是只信令牌。
12. **签名密钥在磁盘上，那就是信任锚。** `~/.dsh/remote-control/jwt-key` 里是 32 个原始字节，
    权限 `0600`。能读这个文件的人可以为任意 `sub` 造一张设备凭证——伪造令牌连配对码都不需要。
    这与「本机账户已被攻破」是同一信任级别：设备表与审计也在那个目录里，
    能读一个的本地攻击者同样能改另外两个。密钥是刻意持久化的——内存中的密钥会完美工作到
    下次重启，然后静默地让所有已配对设备失效。
13. **密钥文件损坏或读不了时，远程接入拒绝启动。** 不会重新生成：重新生成会让所有设备失效，
    *并且*把决定权交给弄坏文件的人。确实想全部取消配对，就手工删掉它。

## 请求流水线

所有到达网关端口的请求，按这个顺序、**只在一个地方**过检（`src/host/gateway/auth.js`）：

```
0. /remote-control/pair?                    -> pairing-route.js（此时还没有凭证）
1. 回环 socket 且回环 Host？                 -> 放行（不需要 cookie）
2. dsh-rc-jwt 验得过？（HS256/iss/aud/exp）   -> 继续；否则 401
3. Origin 围栏：
     Sec-Fetch-Site: cross-site             -> 403（无条件）
     写请求带 Origin，但与 Host 不同源        -> 403
     写请求无 Origin，声明 same-origin/same-site -> 放行
     写请求无 Origin，也无 Sec-Fetch-Site     -> 403
4. sub 已被吊销？                            -> 401 并清除 cookie
   sub 在表里查不到？                        -> 401
   其它                                    -> 放行，设备名从存储里读
```

第 0 步是配对的引导（`gateway/pairing-route.js`），是唯一跑在第 1 步之前的路径——
见安全边界第 9 条。它按精确路径匹配（`/remote-control/pair` 与其带尾斜杠的写法，绝不是前缀），
对自己的 `POST` 跑同一套 Origin 围栏，每个请求都重读 `settings.enabled`，
并且只从进程内存作答，不向上游转发任何东西。

「写」指除 `GET` / `HEAD` / `OPTIONS` 之外的一切。第三条对应 `design.md` §3.2 要的 CSRF 规则；
第四种分支存在，是因为并非每个同源的浏览器写请求都带 `Origin`，把它们拒掉会破坏正常使用。
`Sec-Fetch-Site` 先查，因为页面伪造不了它。

被放行的请求还要在到达 DSH 之前被改写——三条全做，否则官方端口会回 401/403：

| # | 动作 | 原因 |
|---|---|---|
| A | `Host` → `127.0.0.1:<官方端口>` | 官方围栏只接受回环 authority |
| B | 剥掉 `Origin` / `Sec-Fetch-*` | 它比较 `origin.host` 与 `Host`，改写了 `Host` 却留着 `Origin` 是必定的 403 |
| C | 附上内层 `dsh-auth-*` cookie | 官方端口没有回环豁免 |

A 与 B 在同一个函数（`upstreamHeaders`）里完成，因为只做其中一个，正是那种会产出
「无法解释的 403」的配置。

## 各文件职责

```
src/
├── index.js              # 宿主入口：Cordis 插件（name / inject / apply）
├── client.js             # 客户端入口：window.__ModuleLoader__.load 包装
└── host/
    ├── constants.js      # 磁盘布局、数据模型版本、TTL、JWT 声明、文件权限
    ├── store.js          # devices.json 读写、原子写、0600
    ├── pairing.js        # 8 位 base32 配对码、120s TTL、一次性兑换、锁定
    ├── tokens.js         # 设备凭证：HS256 JWT 签发/校验，手写实现
    ├── jwt-key.js        # 加载/创建 32 字节 HS256 密钥，0600，损坏时大声失败
    ├── loopback.js       # 两种传输共用的回环判定
    ├── origin.js         # Origin / Sec-Fetch-Site 围栏，四条分支 + 升级围栏
    ├── audit.js          # JSONL 审计写入、按天清理、导出、分页读取
    ├── classify.js       # 路径 + 方法 -> 审计事件
    ├── api.js            # /remote-control/api/*，仅回环
    └── gateway/
        ├── server.js     # 自建 http.Server、ctx.effect 清理、状态映射
        ├── auth.js       # 唯一的鉴权决定（回环/JWT/Origin/吊销）
        ├── origin.js     # 转出 ../origin.js，保留公开形状
        ├── inner-auth.js # 兑换并缓存上游的 dsh-auth-* cookie
        ├── proxy.js      # HTTP 反向代理：A/B/C 改写、SSE 透传
        ├── wsproxy.js    # WebSocket 升级透传，不用 `ws`
        ├── pairing-route.js # GET/POST /remote-control/pair，兑换的另一半
        ├── activity.js   # lastSeenAt 节流落盘
        └── wire.js       # 响应写入器、cookie 序列化
locale/                   # zh / en 词典
tests/                    # node --test
```

领域模块（`store`、`pairing`、`tokens`、`jwt-key`、`audit`、`loopback`、`origin`）从不 import
`gateway/*`：它们必须能被仅回环的管理 API 复用，也必须能脱离 HTTP 测试。

## 实测数据

两处成本是量出来的，不是猜的，都影响了设计：

- `store.touchDevice()` 每次 **7.06 ms**（一次带 `fsync` 的完整原子写）。每请求调一次会把网关
  压到约 140 req/s，所以 `lastSeenAt` 在内存里按请求更新，每台设备最多每 30 秒落盘一次——
  并在吊销、面板读取与退出时强制 flush。
- 官方端口执行 **Host/Origin 围栏 + 与 authority 绑定的 `dsh-auth-*` cookie，且没有回环豁免**，
  所以朴素的反向代理无论监听怎么配都是 401/403。这就是 A/B/C 改写的由来。

## 数据

| 数据 | 位置 | 说明 |
|---|---|---|
| 设备与设置 | `~/.dsh/remote-control/devices.json` | 权限 `0600`，原子写 |
| JWT 签名密钥 | `~/.dsh/remote-control/jwt-key` | 32 个原始字节，权限 `0600`，首次使用时生成 |
| 审计记录 | `~/.dsh/remote-control/audit-YYYY-MM-DD.jsonl` | 按 UTC 分天，保留 30 天 |

```jsonc
{
  "version": 1,
  "devices": [
    {
      "id": "dev_xxx",            // 它 IS JWT 的 sub，也是行主键
      "name": "iPhone · Safari",
      "ua": "...",
      "createdAt": "2026-10-17T...",
      "lastSeenAt": "2026-10-17T...",
      "revokedAt": null,
      "capabilities": null        // 为将来的能力白名单预留
    }
  ],
  "settings": { "enabled": false, "port": 3090 }
}
```

**不持久化任何凭证。** 令牌在设备手里，文件里只有设备行。这比「只存摘要」更强，
也是改用 JWT 的意义：令牌的权限来自它的签名，文件里没有任何东西可供攻击者对着猜。

**更早的版本**写出的文件里可能还有 `tokenHash` 字段。它会被读取、校验并保留，
好让 `version: 1` 与以前一样能解析——上面的形状说的是这个版本*写*什么，不是它能*读*什么。
带 `tokenHash` 的行再也无法通过鉴权，因为没有任何地方拿哈希去和 JWT 比。

唯一必须常量时间的那次比较是签名校验，而它确实是：两侧先各自 sha256，于是
`crypto.timingSafeEqual` 永远看到 32 字节缓冲。直接比较会在长度不等时抛错，
把「拒绝了一个凭证」变成 500——在一个未鉴权的请求上，这是一个可区分的信号。

`devices.json` 存在但解析不了，是**硬错误**（`store/corrupt`），不是一张空设备表——
当成空表会恰好表现为「所有设备都取消配对了」，而远程接入仍在运行。

## 环境要求

- Node `>= 18`
- dsh `>= 0.2.0-rc.2`
- 零运行时依赖。WebSocket 透传用裸 socket，连 `ws` 都不需要。

## 开发

```bash
node --check src/index.js      # 语法
npm test                       # node:test 测试套件
npm run check:syntax           # 所有宿主模块
```

测试从不碰真实的 `~/.dsh`：每个用例把 store 绑到自己的临时目录，并通过注入的 `now` 钉住时钟，
所以「已过期」是推进一个数字断言出来的，不是 sleep 出来的。

> `node --test tests/` 在 Node 21+ 不工作——`--test` 会把目录参数当作字面 glob，
> 于是目录本身被当成测试文件执行（[nodejs/node#64555](https://github.com/nodejs/node/issues/64555)）。
> 本仓库的 `test` 脚本传的是 glob，在所有版本上都能用。

### 发布

`docs/RELEASING.md` 是操作手册。**先读它的第一节**：`0.1.0` 必须手工发布，因为这个包还不在 npm 上，
而 npm Trusted Publisher 只能配置在已存在的包上。从下一个版本起，推一个 `vX.Y.Z` 标签就会
通过 OIDC 发布到 npm，并创建带同一个 `.tgz` 的 GitHub Release；文档里写清了这条链路哪些部分
能在本地验证、哪些不能。

## 路线图

- [x] **0** 包骨架、清单、bundle patch、单行加载
- [x] **1** 设备存储、配对码、设备令牌（现为签名 JWT）
- [x] **2** 网关 HTTP：监听、鉴权、Origin 校验、内层凭证、代理
  （+ 配对码锁定、+ `lastSeenAt` 节流）
- [x] **3** 网关 WebSocket：升级鉴权、`/api/remote.mux` 透传
- [x] **4** 管理 API（`/remote-control/api/*`，仅回环）与审计
- [x] **5** 客户端面板：总开关与端口在顶部，四 tab（配对 / 接入 / 设备 / 审计），
  设备列表与吊销，审计概览 + 事件明细与动作筛选 + 导出，配对码 + 一次性链接 + 二维码
  （+ 真正兑换配对码的配对路由——`gateway/pairing-route.js`）
- [ ] **6** 真机验证与文档

## 许可证

MIT
