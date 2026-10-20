# Tag & Release

> 标签文法、版本一致性、CHANGELOG 契约、发布流水线、幂等重试与打包边界。

---

## 版本号与标签的唯一事实源

一个版本号同时出现在**三处**，发布脚本逐条比对，任何一处不一致都在 `npm publish` 之前终止：

| 位置 | 谁写 | 谁校验 |
|---|---|---|
| `package.json#version` | `npm version X.Y.Z --no-git-tag-version` | `scripts/prepare-release.mjs` |
| `dsh.plugin.json#version` | 同一次命令的 `version` lifecycle 脚本（`package.json#scripts.version`） | 同上 |
| git tag `vX.Y.Z` | 人手打 | 同上 |

- `scripts.version` 会把 `package.json#version` 写进 `dsh.plugin.json` 并 `git add`，所以**用 `npm version` 而不要手改两个文件**。手改的代价是 `tests/package.test.mjs` 的 "the two manifests agree on the version" 变红——那条断言是**故意脆的**，它红了说明发布错了，不是测试错了。
- `engines.dsh` 也在两个清单里，并且必须与真实宿主对齐。**先跑 `dsh --version` 再填**；本项目曾从别的包推断版本，判错过一次（`docs/RELEASING.md`「Daily release」第 2 步）。
- 不要用 `--no-git-tag-version` 之外的花样：让 npm 顺手打标签会绕过下面的 annotated 约定与 CHANGELOG 前置要求。

## 标签文法

`scripts/prepare-release.mjs` 里只有一条正则，它是语法的唯一定义：

```js
/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/
```

| 标签 | 结果 | 原因 |
|---|---|---|
| `v0.1.0` | ✅ 稳定版 | dist-tag `latest`，普通 Release |
| `v0.2.0-beta.1` | ✅ 预发布 | dist-tag `next`，Release 标 prerelease 且不抢 Latest |
| `v0.1.0+build` | ❌ | 不收 build metadata |
| `v01.1.0` | ❌ | 版本段不得有前导零 |
| `v0.1` | ❌ | 必须三段 |
| `main` | ❌ | 不是版本号 |
| `v0.1.0-beta.01` | ❌ | 数字型预发布标识不得有前导零 |

两个**容易误判**的点：

1. workflow 的触发是 glob `v[0-9]*.[0-9]*.[0-9]*`，**只是粗筛**：`v01.1.0` 能过 glob，但会被 `prepare-release` 的正则拒掉。真语法只有一个来源，别在 workflow 里再写一遍判断。
2. 标签正确但版本不一致同样会被拒（`Tag and package.json version must agree` / `dsh.plugin.json version must agree`）。所以 `tests/release.test.mjs` 里每条非法用例都**钉住拒绝原因**——只钉「抛了」会被另一条校验先拒而永远全绿，这是本项目已修过的真实测试缺陷。

## 标签对象类型

用 **annotated tag**：

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push --atomic origin main vX.Y.Z   # ← 只有人执行，见下节「推送授权」
```

理由与代价都是可查的：`gh release create --verify-tag` 只要求标签已存在于远端（两种都满足），但 annotated 标签带 tagger 与消息，是唯一能回答「谁在什么时候发的这个版本」的对象。历史偏差：仓库里 `v0.1.0` 是**轻量标签**（`git for-each-ref refs/tags` 显示 `objecttype` 为 `commit`），`v0.1.1` 才是 annotated。既有的轻量标签不必重建，新标签一律 `-a`。

`git push --atomic` 是要求而非习惯：提交与标签要么一起到远端，要么都不动，避免「标签指向一个远端没有的提交」。

## 推送授权

> **硬约束：没有明确的许可，不得执行任何推送。**

`git push` 的全部变体——`--atomic`、`--tags`、`--follow-tags`、`--force` / `--force-with-lease`、`--mirror`、`--delete`，以及等价写法（别名、`git -C <dir> push`、脚本或 `gh` 里的推送）——只能由人执行。AI 可以 `git add` / `git commit` / `git tag -a`，因为它们是**本地的、可撤销的**；推送是本流程里唯一不可撤销的一步，且它的后果发生在机器之外。

单独立一条规则的理由：

- 推 `vX.Y.Z` 会立刻触发 `.github/workflows/npm-publish.yml`，发布一个 **npm 不允许覆盖**的版本、创建 GitHub Release，并改变别人 `npm install` 看到的 `latest`。`git tag -d` 撤不回已经发出去的版本。
- **授权不能从上下文推断。** 讨论里说过「可以发版」不是对某条具体推送命令的授权；只有用户明确要求推送、或被问到后明确同意，才算许可。含混的「行」「可以」如果指的是上一步（比如跑测试），不算。
- 边界与 `.trellis/workflow.md` Phase 3.4 一致：提交按批次计划执行，**推送必须停下来问人**。

### 契约

| 动作 | 谁做 | 备注 |
|---|---|---|
| `git add` / `git commit` | AI（Phase 3.4 的批次计划，一次确认后执行） | 本地，可 amend / rebase |
| `git tag -a vX.Y.Z` | AI 或人 | 本地，未推送前 `git tag -d` 可撤 |
| 任何 `git push` | **只有人** | AI 最多打印命令并写明后果 |
| `npm publish` | 只有人 | 本仓库应由 tag 触发 OIDC，不该本地发 |
| `git ls-remote` / `git fetch` / `git log origin/main` / `gh release view` | AI | 只读，用来核对远端状态 |

### 需要推送时的流程

1. 先摆事实：`git log --oneline origin/main..HEAD`、`git status --porcelain`、目标标签是否已在远端（`git ls-remote --tags origin vX.Y.Z`）。
2. 打印**完整命令**并写明后果，例如「推 `v0.1.2` 会触发 `npm-publish.yml`：发布 `@misaka10091/dsh-remote-control@0.1.2` 到 npm 并建 Release，不可回滚」。
3. **停在这里**，等人执行，或等一句明确的推送授权。
4. 推送发生之后，AI 才用只读命令核对结果。

### Wrong vs Correct

```bash
# Wrong：把「验证发布流程」理解成顺手推一下
git tag -a v0.1.2 -m "Release v0.1.2" && git push --atomic origin main v0.1.2
# → 版本已发到 npm，无法覆盖；用户可能还没同意发这个版本

# Correct：标签留在本地，命令与后果交给人
git tag -a v0.1.2 -m "Release v0.1.2"
# 报告：
#   待执行（需你确认）：git push --atomic origin main v0.1.2
#   后果：触发 npm-publish.yml → npm publish 0.1.2 + GitHub Release（不可回滚）
```

> **Warning**：这条规则**没有测试守着**，也没有脚本会拦你——CI 由 tag 推送触发，推出去就是既成事实。唯一防线是执行前问一句。

## CHANGELOG 契约

`CHANGELOG.md` 不是给人看的摘要，它是**发布说明的唯一来源**：

- 标题格式固定 `## vX.Y.Z — YYYY-MM-DD`（注意是 em dash `—`，两侧各一个空格）。`prepare-release` 用 `line.startsWith("## " + tag + " — ")` 定位段落，写成 `## v0.1.0 - 2026-10-17` 会找不到段落并终止发布。
- 段落必须非空（截到下一个 `## ` 为止，`trim()` 后不能是空串）。
- 段落正文被**逐字**用作 GitHub Release 正文，脚本再追加一段固定的 `### Installation`：

  ```sh
  dsh plugin --profile web add @misaka10091/dsh-remote-control@X.Y.Z
  ```

- **`--profile web` 不能写成 `--profile desktop`**：`desktop` profile 由 Electron 应用托管，会拒绝 CLI 插件命令（`README.md`「安装」）。这条有专门测试守着（`tests/release.test.mjs` 的 "the release notes install with the web profile, never desktop"），因为抄别的仓库的发布说明正是会犯这个错的方式。
- **先写 CHANGELOG 再打标签**，不是发布后补。标签要描述「已经发出去的东西」，而 Release 正文是从这个段落读的。

## dist-tag 与 Release 形态

| 版本 | npm dist-tag | GitHub Release |
|---|---|---|
| 稳定版 `vX.Y.Z` | `latest` | 普通 Release（默认成为 Latest） |
| 预发布 `vX.Y.Z-<pre>` | `next` | `--prerelease --latest=false`，不动 Latest |

- dist-tag 在 `npm publish --tag <dist-tag>` 这一次操作里设定，**不跑** `npm dist-tag add`。npm 侧 Trusted Publisher 的「Allow npm dist-tag」开关对应的是单独管理 dist-tag 的权限，本流水线不需要（`docs/RELEASING.md` 有该开关的判定依据）。
- 预发布不会把 `latest` 往前推。发布一个新版本，而不是把旧版本重新发成 `latest`——npm 也不会允许重发已存在的版本。

## 发布流水线

`.github/workflows/npm-publish.yml`，触发条件只有两个：`push.tags: v[0-9]*.[0-9]*.[0-9]*` 与 `workflow_dispatch`（手工重跑时必须输入一个**已存在**的标签）。

步骤顺序是有语义的，不要重排：

1. `actions/checkout` 用 `ref: refs/tags/<tag>`、`fetch-depth: 0` —— **永远读标签指向的提交**，不是发起运行的分支。手工重跑时选哪个分支都无意义。
2. `node scripts/prepare-release.mjs "$RELEASE_TAG" "$RUNNER_TEMP/release"` —— 校验并产出 `notes.md` / `metadata.json`，同时把 `package` / `version` / `dist_tag` / `prerelease` 写进 `GITHUB_OUTPUT`。
3. `npm run check:syntax` → `npm test` → `npm pack --dry-run` —— 与 CI 相同的三条 gate。
4. `npm pack --pack-destination … --json` —— **只打包一次**，后面发布与 Release 上传用的是同一个 `.tgz`。
5. 幂等发布（见下节）。
6. `gh release create … --notes-file notes.md`，上传第 4 步那个 `.tgz`。

权限与环境：

- 顶层 `permissions: contents: read`；job 级追加 `id-token: write`（OIDC 换 npm 凭据）与 `contents: write`（建 Release、传资产）。
- **不出现 `secrets.*`、不出现 `NPM_TOKEN`**。序列里出现 secret 引用即是回归。
- `concurrency: npm-release-<tag>` + `cancel-in-progress: false`：重跑同一个标签必须能跑完，而不是打断它要接续的那次运行。
- runner 固定 GitHub 托管 `ubuntu-latest` + Node 24 + `npm install --global npm@11`（Trusted Publisher 要求 npm ≥ 11.5.1、Node ≥ 22.14.0）。
- `.github/workflows/ci.yml` 在每次 push `main`、每个 PR、可手动触发时跑同样三条 gate，**不带任何 secret**。所以标签推送永远不是测试第一次运行。

## 幂等与重试

失败后**重跑同一次运行**，不要改版本号重来（npm 不接受覆盖，改了就等于发两个版本）。脚本为此把「已经发过」当成可继续的状态：

```bash
# npm view 成功 → 比对 integrity；E404 → 才是真正需要 publish
npm view "$PACKAGE_SPEC" dist.integrity --json
```

| 情形 | 行为 |
|---|---|
| `npm view` 返回完整性值且与本次 `pack.integrity` **相同** | 跳过 `npm publish`，继续建 Release（这是「npm 成功、Release 失败」的重跑路径） |
| `npm view` 返回完整性值但**不同** | 中止，必须 bump 版本 |
| `npm view` 报 `E404`（版本不存在） | `npm publish "$TARBALL" --access public --tag "$DIST_TAG"` |
| `npm view` 报其它错误 | 错误原文打到 stderr 并 `exit 1`，不吞 |

其它固定行为：

- **测试/语法失败**：流程停止，什么都没发布。
- **npm 失败**：不会创建 Release。
- **Release 已存在**：`gh release upload "$RELEASE_TAG" "$TARBALL" --clobber` 重传同一个 `.tgz`。
- **Trusted Publisher 显示 Pending validation**：只能靠该 workflow 真的发布一个**尚不公开**的版本才会清掉。重跑已发布版本会走「跳过上传」分支，永远清不掉；本地 `npm publish` 与 `npm whoami` 也不行。

## 打包边界

`package.json#files` 就是发布边界。任何新增的宿主模块必须同时满足三件事，缺一就会在用户机器上炸：

1. 进 `files` 白名单；
2. 进 `scripts['check:syntax']` 的显式清单（不是 glob，所以必须手写）；
3. 若是网关模块，`tests/package.test.mjs` 的 "the gateway modules exist and are all packaged" 里也要出现。

实测产物为 **33 个文件**：`icon.svg`、`locale/{zh,en}.json`、`src/index.js`、`src/client.js`、`src/host/*.js`（13 个，含 `tunnel.js` / `tunnel-binary.js`）、`src/host/gateway/*.js`（9 个）、`cordis.patch.yml`、`dsh.plugin.json`、`README.md`、`CHANGELOG.md`、`LICENSE`、`package.json`。`scripts/` 与 `.github/` 故意不在其中。

- 这个 31 **没有测试守着**（没有任何断言钉住文件数）。改动后自己数，别引用旧数字；`npm pack --dry-run` 里多出来的就是泄漏，少了的就是打包 bug。
- `src/host/addresses.js` 是「加进 `src/` 却忘进白名单」这类事故的典型：它同时被 `store.js` 与 `api.js` import，漏掉它不只是少个功能，而是插件加载即失败。对应的断言与注释就在 `tests/package.test.mjs`。
- `package.json#scripts.version` 里 `git add dsh.plugin.json` 是流水线的一部分（`npm version` 后两个清单要一起提交），不要删。

## 本地能证明什么不能证明什么

| 层 | 手段 | 能证明 | 本地可验 |
|---|---|---|---|
| 1 | `node --test tests/release.test.mjs` | 校验规则接受一个正确发布、并逐条拦住每个错误发布 | ✅ |
| 2 | `node scripts/prepare-release.mjs vX.Y.Z <dir>` | 脚本在本仓库真实清单与 CHANGELOG 上跑通，产出 `notes.md` + `metadata.json` | ✅ |
| 3 | 手工解析两个 workflow 文件 | YAML 能解析，触发条件与权限就是声明的那样 | ✅ 但**没有测试守着**，靠人做 |
| 4 | 一次真实 tag 推送 | OIDC 发布与 GitHub Release 端到端真的成立 | ❌ 只能靠真跑 |

- 第 4 层**在本仓库从未运行过**。因此：任何文档、CHANGELOG、README 都不能把这条自动化写成「已验证」。现在能说的是「规则可单测、脚本可干跑、workflow 可解析」。
- 第 1–3 层看不见 npm 侧账号状态：2FA、scope 权限、待验证的 Trusted Publisher。这些只在真跑时暴露。
- 同理，`README.md` 里「阶段 6 真机验证未执行」这句话在真的有人用手机走完「扫码 → 打开会话 → 发消息 → 收到流式输出 → 停止」之前不能改；Node 层对真实 socket 的测试不是替代品，CHANGELOG 也不能暗示已经替代。

## 常见错误

- **在 workflow 里写判断。** YAML 里的 `if`/`grep` 只能在真实推送时才知道对错，且无法单测。能静态判定的东西一律进 `scripts/prepare-release.mjs` 这个纯函数。
- **断言只钉「被拒了」。** `assert.throws(() => …)` 不带原因，会被另一条更早的校验满足，删掉本意要测的规则测试依然全绿。本仓库为此修过一次（11 个变异体里 2 个存活）。
- **先打标签、后写 CHANGELOG。** 结果是 Release 正文缺失或为空，发布被拒；或者反过来，正文描述的是「打算发的」而不是「发出去的」。
- **手改两个清单的 version。** 用 `npm version X.Y.Z --no-git-tag-version`，让 lifecycle 脚本同步。
- **猜 `engines.dsh`。** 跑 `dsh --version`。
- **把已发布版本重新发成 `latest`。** 不允许，也不需要：发新版本。
- **给生产 workflow 加 `NPM_TOKEN`。** OIDC 就是凭据；加 secret 等于多一条会过期的凭证链。
- **重跑时把 `cancel-in-progress` 打开。** 会把要接续的那次运行打断。
- **未经许可就推送。** 推送是唯一不可撤销的一步，也是唯一会真的发布版本的一步；AI 只打印命令，等人执行或等明确许可（见「推送授权」）。
- **把「提交」当成「推送」授权。** Phase 3.4 的批次计划只覆盖 `git add` / `git commit`，不含任何 `git push`。
- **用轻量标签。** `git tag -a`，并 `git push --atomic`。
- **引用「33 个文件」当常量。** 它是实测值，改包必须重新数。

## 验证命令

```bash
# 1. 规则层
node --test tests/release.test.mjs

# 2. 真实清单干跑（不联网、不发版）
node scripts/prepare-release.mjs vX.Y.Z "$TMPDIR/release-dry-run"
#   检查：notes.md 含本次 CHANGELOG 正文 + Installation 段（--profile web）
#   检查：metadata.json 的 dist_tag 是 latest 或 next，prerelease 与之一致

# 3. 三条 gate
npm run check:syntax
npm test
npm pack --dry-run        # 33 个文件，无 scripts/、无 .github/

# 4. 标签（真发布，不可回滚）
git tag -a vX.Y.Z -m "Release vX.Y.Z"
# 5. 推送 —— 只有人执行；未经许可不得运行（见「推送授权」）
git push --atomic origin main vX.Y.Z
```

## 参考文件

- `scripts/prepare-release.mjs` —— 全部静态校验与发布说明生成（纯函数 + CLI）
- `tests/release.test.mjs` —— 规则的单测，含「钉住拒绝原因」与 `--profile web` 断言
- `.github/workflows/npm-publish.yml` —— 标签触发的 OIDC 发布 + Release
- `.github/workflows/ci.yml` —— 每次 push/PR 的三条 gate
- `docs/RELEASING.md` —— 人读的操作手册（首发手工发布、Trusted Publisher 配置、失败重跑）
- `package.json#scripts.version` / `#scripts.check:syntax` / `#files`
- `tests/package.test.mjs` —— 打包与清单不变量
- `CHANGELOG.md` —— 段落格式与历史发布说明
