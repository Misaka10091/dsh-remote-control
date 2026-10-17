# Type Safety

> Type safety patterns in this project.

---

## Overview

本项目**不使用 TypeScript**，两侧都是纯 JavaScript（宿主 ESM、客户端 `__ModuleLoader__` 工厂）。没有构建步骤，所以没有类型检查这一关。

这不是"类型无关紧要"，而是**把类型责任转移到了三处**：

1. JSDoc 注释（给人和编辑器看）。
2. 运行时校验（给数据看）。
3. 测试断言（给行为看）。

---

## Type Organization

- 用 JSDoc 描述函数入参与返回值，尤其跨模块边界：

```js
/**
 * @param {string} code  用户输入的 8 位配对码
 * @returns {{ deviceId: string, token: string }} 明文 token 只在此处出现一次
 * @throws {Error & { code: 'pairing/expired' | 'pairing/used' }}
 */
export function redeemPairingCode(code) { /* ... */ }
```

- 跨模块共享的数据结构（设备记录、审计事件、API 响应）在**定义它的模块**里写一次 JSDoc `@typedef`，其他模块引用而不重复描述。

## Validation

运行时校验只做**边界**校验，不做全量 schema 校验（不引入 zod 等库）：

- **入口校验**：HTTP 请求体、配对码输入、端口号、设备名。非法输入立刻拒绝。
- **落盘校验**：读 `devices.json` 后检查 `version` 与必需字段；不合法抛 `store/corrupt`。
- **上游响应**：不校验。代理不理解 DSH 业务语义（`design.md` §2），解析响应体反而会成为升级脆点。

校验失败一律走显式错误码，不静默修补。

## Common Patterns

- 环境探测：可选依赖不存在时返回 `undefined` 并降级，而不是抛错。
  ```js
  const connection = ctx.get('connection')  // 可能 undefined
  if (connection === undefined) ctx.logger.warn('[remote-control] connection service unavailable; inner auth disabled')
  ```
- 错误区分靠 `error.code` 字符串，不靠 `instanceof`（见 `../backend/error-handling.md`）。

## Forbidden Patterns

- **不写 `.d.ts`。** 没有编译步骤，手写声明文件只会与实际代码漂移。
- **不为了"类型完整"引入 TypeScript 工具链。** 这与"无构建步骤"约束直接冲突。
- **不用 `as` / 类型断言麻痹问题**——JS 里没有，但等价行为（强转、跳过校验）同样禁止。
- **不在客户端半边用 `import`。** 见 `component-guidelines.md`。
