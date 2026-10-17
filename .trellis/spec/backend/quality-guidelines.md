# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

本项目是 DSH 插件：**一个没有构建步骤的 npm 包**，同时被 Node（宿主半边）和浏览器（客户端半边）加载。质量的红线都是围绕这两件事展开的——加载期不能崩，鉴权期不能漏。

---

## Forbidden Patterns

1. **引入运行时依赖。** 宿主半边只用 Node 内置模块（`node:crypto`、`node:fs`、`node:path`、`node:os`、`node:http`、`node:net`）。唯一允许的是宿主提供的可选模块（如 `@deepseek-ai/schemastery`，按 `dsh-git-panel` 的方式动态可选加载，缺失时降级）。
   *例外*：WebSocket 需要 `ws`。若必须引入，它要作为 `dependency` 并在 README 说明，且不得引入第二个用途重叠的库。

2. **新增构建步骤。** 客户端半边是手写 ESM，保留 `window.__ModuleLoader__.load({ id, factory })` 单入口包装，禁止出现第二个 client entry 或编译产物目录。

3. **`shell: true` / 命令拼接。** 本项目不需要执行外部命令。若将来需要，一律 argv 数组，禁止 `exec`。

4. **`console.log` 作为日志。** 宿主用 `ctx.logger`。

5. **静默降级。** 缺少可选能力时降级可以，但必须 `warn` 一次并在 UI 上可见，不允许"看起来在工作，实际没生效"。

6. **在日志/响应里出现令牌、Cookie、配对码、消息正文。**

7. **`chmod` 失败即抛错（Windows）。** 0600 是 POSIX 语义，Windows 上是 no-op，不得因此让插件启动失败。

---

## Required Patterns

1. **可注入的副作用。** 文件系统根目录、时钟、随机源作为参数传入。测试不碰真实 `~/.dsh`，不等待真实时间。

2. **原子写。** `devices.json` 写入必须是「临时文件 → fsync → rename」，任何时刻读到的都是完整文件。

3. **常量时间比较，且用在真正的热路径上。** 令牌比对先各自 sha256 再 `crypto.timingSafeEqual`，保证长度恒等，避免长度侧信道与抛错。
   **但只做到这一步是不够的**：阶段 1 复核发现 `tokens.js` 是常量时间的，而真正会被调用的 `findActiveDeviceByTokenHash` 却用 `===` 早退——等于白做。任何**比对凭据摘要**的地方都必须走同一个 `sameTokenHash()`。

4. **接受凭据的一方必须校验格式。** `verifyToken` 的可信侧（存储的 `tokenHash`）必须是 `^[0-9a-f]{64}$`，否则直接返回 false。
   阶段 1 复核发现的真实缺陷：旧实现把非摘要也走一遍 hash，导致 `verifyToken('hunter2','hunter2') === true`；配合存储接受任意非空字符串，**手写一个字段进 `devices.json` 就能用该字面量认证**，完全绕过「只存哈希」。这条要一直记着。

5. **注入的随机源要防御。** `random()` 是可注入的，就必须检查返回的字节数；短缓冲会静默产出 `undefined` 拼成的码。抛 `pairing/entropy`，不要静默修补。

6. **`ctx.effect()` 清理。** 任何监听端口、定时器、事件订阅都必须在 effect 的 disposer 里释放。热加载与禁用插件后不得残留监听。

7. **单向依赖。** 见 `directory-structure.md`：领域模块不得 import `gateway/*`。

8. **固定顺序的鉴权判定。** loopback 豁免 → 设备 Cookie → Origin → 吊销状态。顺序写死在一处（`gateway/auth.js`），不要散落在多个 handler 里。

9. **短写必须处理。** `writeSync` 的返回值不能忽略，要按 offset 循环。否则短写会通过 `rename` 发布一个被截断的文档——正好是临时文件那套机制要防的事。

10. **版本一致。** `package.json` 与 `dsh.plugin.json` 的 `version` 必须相等，且 `files` 列出的每个产物必须真实存在。
    `engines.dsh` 必须与**实测**的宿主版本对齐（用 `dsh --version` 复验，不要从二手信息推断——阶段 1 复核曾误判一次）。

---

## Testing Requirements

- 测试运行方式：`npm test`（内部 `node --test "tests/*.test.mjs"`）。不引入测试框架依赖，用 `node:test` + `node:assert/strict`。
  **注意**：`node --test tests/` 在 Node 21+ 失效（目录参数被当字面 glob，目录本身被当测试文件执行，[nodejs/node#64555](https://github.com/nodejs/node/issues/64555)）。裸 `node --test` 可用。
- 必有单测覆盖（阶段 1 起逐阶段累积）：
  - 配对：兑换成功、重复兑换失败、过期失败。
  - 令牌：正确令牌通过、错误令牌失败、长度不同的令牌不抛错只失败、**非摘要的「哈希」被拒**。
  - 存储：原子写后可读回、损坏文件报 `store/corrupt`、Windows 下 chmod 不抛错、**非法 tokenHash 被拒**。
  - 审计：追加格式合法、30 天清理、导出不含正文。
- **文件级不变量测试**：断言 manifest 与 package 版本一致、`files` 全存在、客户端只有一个 ModuleLoader 入口、宿主半边不出现 `exec(`／`shell: true`。
- **验证测试真的能失败**：写完一条断言，故意改坏实现确认它变红，再还原。阶段 1 复核发现过 `assert.ok(() => JSON.parse(raw))` 这种永真式（函数对象恒为真值，根本没解析）。
- 真机验证（手机扫码、流式输出、吊销即时生效）不属于 `npm test`，由 `implement.md` 阶段 6 单独执行并记录结论。

## Code Review Checklist

- [ ] 鉴权判定是否只在 `gateway/auth.js` 一处？有没有 handler 自己判断 Cookie？
- [ ] 内层 Cookie 是否只存在于网关→上游这一跳？有没有可能出现在响应头或日志里？
- [ ] 每个 `register*` / `listen` / `setInterval` 都有对应 disposer？
- [ ] 新增的 `catch` 是否吞掉了不该吞的错误？
- [ ] 响应体里有没有泄漏路径、URL、摘要？
- [ ] 测试是否真的能失败？（把断言改坏能不能红）
- [ ] `package.json` 与 `dsh.plugin.json` 版本是否一致？`engines.dsh` 与 `dsh --version` 是否对得上？
- [ ] **可信侧的凭据格式校验了吗？**（`verifyToken` 的 expectedHash 必须是摘要，否则手写字段即认证）
- [ ] **比对凭据摘要的每一处都走常量时间了吗？**（不是只有一个模块做对就算）
- [ ] 注入的 `random()` 返回短缓冲时会不会静默产出畸形值？
- [ ] `writeSync` 的返回值用了吗？
