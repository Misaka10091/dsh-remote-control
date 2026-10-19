# 设计：GitHub 发布流

> 对应 `prd.md` R1–R6。参考实现：`D:\workspace\github\dsh-git-panel` 的
> `.github/workflows/{ci,npm-publish}.yml`、`scripts/prepare-release.mjs`、`tests/release.test.mjs`、`docs/RELEASING.md`。
> 结构照搬，差异逐条列在 §5，避免「抄了形状、漏了差异」。

## 1. 新增文件

```
.github/workflows/ci.yml            CI：语法 + 测试 + 打包清单
.github/workflows/npm-publish.yml   标签触发的 OIDC 发布 + GitHub Release
scripts/prepare-release.mjs         发布校验（纯函数 + CLI）
tests/release.test.mjs              发布校验的单测
docs/RELEASING.md                   重写（现有内容保留并补齐）
package.json                        加 scripts.version；check:syntax 追加新脚本
```

`.github/` 与 `scripts/` 都**不进 npm 包**：`package.json#files` 是白名单，两者都不在名单里，`npm pack --dry-run` 的 31 个文件不变（验收 7）。

## 2. `scripts/prepare-release.mjs`

与参考实现同构，导出 `prepareRelease({ tag, pkg, manifest, changelog })`，并支持
`node scripts/prepare-release.mjs <tag> <output-dir>` 直接运行（写 `notes.md`、`metadata.json`，有 `GITHUB_OUTPUT` 时追加四行输出）。

校验顺序（任一条失败即断言终止，消息指名道姓）：

| # | 校验 | 失败信息要点 |
|---|---|---|
| 1 | 标签文法 `^vX.Y.Z(-prerelease)?$`，且无 build metadata | `Release tag must be vX.Y.Z or vX.Y.Z-prerelease` |
| 2 | 预发布标识符不得有前导零（`beta.01`） | 语义化版本规则 |
| 3 | `pkg.name === '@misaka10091/dsh-remote-control'` | 防止在错误的仓库里发布 |
| 4 | `pkg.version === tag` | 标签与 package.json 必须一致 |
| 5 | `manifest.version === tag` | 标签与 dsh.plugin.json 必须一致 |
| 6 | `pkg.repository.url === 'git+https://github.com/Misaka10091/dsh-remote-control.git'` | npm provenance 绑定仓库，写错等于 provenance 指向别处 |
| 7 | `CHANGELOG.md` 有 `## <tag> — ` 段落且正文非空 | 没有对应段落就不许发 |

产出：`{ package, version, tag, dist_tag, prerelease, notes }`，`dist_tag = prerelease ? 'next' : 'latest'`。
Release 正文 = 该版本段落 + 安装小节：

```sh
dsh plugin --profile web add @misaka10091/dsh-remote-control@<version>
```

（用 `web` 而不是 `desktop`：本仓库 `README.md` 明确写了 desktop profile 由 Electron 应用托管、拒绝 CLI 插件命令。）

## 3. `npm-publish.yml` 的步骤顺序与幂等

```
checkout(ref = 标签, fetch-depth: 0)
setup-node(Node 24, registry-url=npmjs)
npm i -g npm@11                      # Trusted Publisher 需要 npm ≥ 11.5.1
node scripts/prepare-release.mjs     # 校验 + 生成 notes.md + 输出四行
npm run check:syntax / npm test / npm pack --dry-run
npm pack --pack-destination <tmp>    # 只打一次包，后续都复用它
npm publish <tarball> --access public --tag <dist_tag>
gh release create|upload <tarball>
```

幂等（与参考实现逐条一致，这是它踩过坑后写下的）：

- 发布前先 `npm view <pkg>@<version> dist.integrity`：
  - 查到且与本次 tarball 的 `integrity` **相同** → 跳过 npm 上传，继续建 Release（覆盖「npm 成功但 Release 失败」的重跑）；
  - 查到但**不同** → 终止并提示升版本（npm 不允许覆盖已发布版本）；
  - `E404` → 正常发布；
  - 其它错误 → 原样打印并失败，不吞。
- Release 已存在 → `gh release upload --clobber` 补传附件；不存在 → `gh release create --verify-tag`，prerelease 时加 `--prerelease --latest=false`。

## 4. 权限与凭据

```yaml
permissions:
  contents: read        # 顶层最小
jobs.publish.permissions:
  id-token: write       # OIDC：npm Trusted Publisher 唯一凭据来源
  contents: write       # 建 Release / 传附件
```

不出现 `NPM_TOKEN`、不出现 `secrets.*`（验收 1、2；PRD D2）。`concurrency` 按标签分组且 `cancel-in-progress: false`，避免同一标签两次运行互相打断。

## 5. 与参考实现的差异（逐条）

| 项 | dsh-git-panel | 本仓库 | 原因 |
|---|---|---|---|
| 包名 | `@misaka10091/dsh-git-panel` | `@misaka10091/dsh-remote-control` | 包身份 |
| 仓库地址 | `.../dsh-git-panel.git` | `.../dsh-remote-control.git` | provenance 校验 |
| 安装命令 | `--profile desktop` | `--profile web` | 本仓库 README：desktop profile 拒绝 CLI 插件命令 |
| 测试入口 | 显式列出测试文件 | `node --test "tests/*.test.mjs"` | 本仓库既有约定，新测试自动纳入 |
| `check:syntax` | 只查两个入口 | 22 个模块的显式清单 | 本仓库约定；新脚本追加进清单 |
| 版本同步 | `npm run version` 同步 `dsh.plugin.json` 并 `git add` | 同样新增 `scripts.version` | 本仓库有 `tests/package.test.mjs` 断言两份清单版本一致 |
| 其它 | 有 `check:ssr` 等专项 | 无 | 本仓库无 SSR 面 |

## 6. 验证边界（写进文档与报告）

| 层 | 手段 | 能证明什么 | 本地可跑 |
|---|---|---|---|
| 1 | `tests/release.test.mjs` | 校验逻辑正确（6 类输入各自终止/通过） | ✅ |
| 2 | `node scripts/prepare-release.mjs v0.1.0 <tmp>` | 脚本在本仓库真实数据上跑得通、产物形状对 | ✅ |
| 3 | 工作流 YAML 语法/动作版本 | 文件能解析、权限与触发条件符合预期 | ✅（解析 + 人工核对） |
| 4 | 真实 OIDC 发布 + GitHub Release | 发布链路真的能用 | ❌ 只能由一次真实标签推送验证 |

第 4 层在跑过之前**不得**写成已验证；`docs/RELEASING.md` 与任务报告都要如实标注（验收 8）。

## 7. 已知限制

- 首发（0.1.0）无法由工作流完成：npm 上尚无该包，Trusted Publisher 需要已存在的包（PRD 背景）。文档给出手工首发步骤。
- Trusted Publisher 保存后可能显示 **Pending validation**，需要该工作流真实发布一个尚未公开的版本才能消掉；重跑已公开版本不能完成验证。
- 工作流不校验 npm 侧 2FA/账号状态——那是账号层面的事，只能在真实运行时暴露。
