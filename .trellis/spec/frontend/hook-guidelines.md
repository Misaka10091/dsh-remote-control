# Hook Guidelines

> How hooks are used in the browser half.

---

## Overview

只用 React 内置 hooks（`useState` / `useEffect` / `useRef` / `useCallback` / `useMemo`）。没有数据请求库（不用 React Query / SWR）——请求很少且都在面板打开时发生，自带 `fetch` 足够。

---

## Custom Hook Patterns

自定义 hook 只在**同一段逻辑被两处以上用到**时才提取。当前预期只有两个：

| Hook | 职责 |
|---|---|
| `useGatewayStatus()` | 拉取并订阅网关状态（启用与否、端口、设备列表、在线数） |
| `usePairing()` | 发起配对、倒计时、复制、取消 |

规则：

- hook 内部不渲染任何东西，只返回数据与动作函数。
- 所有定时器/订阅在 hook 自己的 `useEffect` cleanup 里关掉，调用方不需要记得清理。
- hook 的依赖数组引用的 const 必须**先声明后使用**（`dsh-git-panel` 踩过这个坑：依赖数组里出现后声明的 const 会拿到 TDZ 值）。

## Data Fetching

- 用全局 `fetch`，相对路径（`remote-control/api/...`，无前导斜杠）。
- 统一走一个小的请求封装，把 `{ ok, data, error }` 解包成「返回值或抛错」，让组件只处理成功路径 + 一个 catch。
- **不自动重试**。失败就把错误态渲染给用户；自动重试会在服务端确实不可用时刷屏日志。
- 状态订阅优先用 `EventSource`（SSE，单向、自带重连）。官方连接走 WebSocket 是另一回事，那是 DSH 自己的通道，我们只做代理，不接管。

## Naming Conventions

- `useXxx`，与返回值语义一致（`useGatewayStatus` 返回状态，`usePairing` 返回配对动作与过程态）。
- 动作函数用动词开头：`refresh`、`revoke`、`startPairing`、`cancelPairing`。

## Common Mistakes

- **在 effect 里直接建 EventSource 但没有 cleanup。** 面板关掉后连接还在。
- **把 fetch 写进渲染体。** 每次渲染都发一次请求。
- **用 `useEffect` 的 cleanup 清状态**（在 cleanup 里 `setState`）。卸载后 setState 会告警且无意义，只清外部资源。
- **依赖数组漏项导致 stale closure。** 需要读最新值时用 `useRef` 镜像，而不是从依赖里删掉那个变量。
