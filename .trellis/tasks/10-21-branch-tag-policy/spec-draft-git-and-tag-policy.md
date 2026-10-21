# Spec 草案 · 分支 / 合并 / 版本语义 / Release 形态

> **这是草案，不是规范。** 目标位置：
>
> | 草案章节 | 落地文件 |
> |---|---|
> | A | `.trellis/spec/release/branch-and-merge.md`（新建） |
> | B | `.trellis/spec/release/versioning.md`（新建） |
> | C | 对 `release/index.md`、`release/tag-and-release.md` 的修订 |
> | D | GitHub 侧配置清单（`docs/RELEASING.md` 新增一节） |
>
> 依据：`research/01-github-practices.md`、`research/02-versioning-and-release-shape.md`、`research/03-gap-analysis.md`。

---

# A. `release/branch-and-merge.md`（草案全文）

````markdown
# Branch & Merge

> 分支模型、命名、PR 判据、合并方式、提交与 PR 标题规范。

---

## 模型：一条长期分支 + 可选短命分支

`main` 是唯一的长期分支，且始终可发布。**不存在** `develop`、`next`、`release/*` 长期分支：

- 预发布由标签表达（`v0.2.0-beta.1` → npm dist-tag `next`），不由分支表达。两套表达 = 两套事实源。
- `release/x.y` 目前**不允许建**：不是「用不上」，而是发布路径还没有能力把维护版本送到正确的 dist-tag。三个前置改造见本文「维护分支」。

分支是**短命的、按需的**，不是必需动作。它的唯一作用是：让 CI 在合并前跑一次、并留下 PR 记录。所以判据不是「改动大不大」，而是：

> **这次改动值不值得在进 `main` 之前让 CI 跑一次？**

| 情形 | 直推 `main` | 开分支 + PR |
|---|---|---|
| 只改 `docs/`、`CHANGELOG.md`、`.trellis/`、注释、README 文案 | ✅ | 可选 |
| 改单个源文件且 `npm test` 已本地跑绿 | ✅ | 可选 |
| 改 `.github/workflows/**` | ❌ | ✅ 必须 |
| 改 `package.json`、`scripts/prepare-release.mjs`、`install` 相关 | ❌ | ✅ 必须 |
| 改 `src/host/gateway/**`（鉴权、代理、配对） | ❌ | ✅ 必须 |
| 单次改动跨 ≥ 3 个源文件 | ❌ | ✅ 必须 |

后四行的共同点：**错了要有人/机器在合并前看一眼**。直推的唯一代价是失去「合并前的 CI」，所以只在「本地已经证明过」时可用。

`main` 上开启 "Require a pull request before merging" 会取消本表的直推路径。"Require status checks" 则要求目标提交在更新受保护分支**之前**已有通过的检查结果，并不天然要求 PR：同一提交可以先在其他分支取得检查结果，再直推 `main`（[官方说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)）。

当前 `ci.yml` 的自动触发只有 push `main` 与 PR；虽然也有 `workflow_dispatch`，本仓库尚未定义并验证「同一 SHA 先检查、后直推」的流程。因此目前保留直推，暂不开 required PR / checks（理由与代价见 D1）。以后可以选择统一走 PR，或补齐同一 SHA 的预先检查流程；届时同步更新本表。

## 分支命名

```
<type>/<slug>
```

- `type` 与提交类型同一词表（见下节）：`feat` `fix` `docs` `chore` `refactor` `test` `ci` `perf`
- `slug` 全小写、用连字符、2–5 个词，描述「做什么」而不是「谁在做」
- 不与 Trellis 任务目录名冲突：任务目录是 `MM-DD-slug`，分支用纯 `slug`

| 示例 | 判定 |
|---|---|
| `fix/pairing-code-reuse` | ✅ |
| `docs/release-spec-sync` | ✅ |
| `feat/cloudflared-tunnel` | ✅ |
| `ZhangSan-patch` | ❌ 无 type，且是「谁」 |
| `fix_tunnel` | ❌ 用下划线 |
| `10-21-pairing` | ❌ 混入任务日期前缀 |
| `main`、`master`、`dev` | ❌ 不是短命分支名 |

合并后**立即删除分支**，本地 `git branch -d`，远端靠仓库设置的 "Automatically delete head branches"。分支没删不代表工作未完成，但会让 `git branch -a` 失去信息量。

## 合并方式：只用 squash

```bash
gh pr merge --squash --delete-branch    # 或网页上 Squash and merge
```

- **禁止 merge commit**：`main` 的历史是线性的，`git log --oneline` 每条都是一个完整变更。
- **禁止 rebase and merge**：GitHub 的 rebase 合并会重写提交且**不带签名验证**（官方文档明写），head 分支有冲突时还要人 force push。
- squash 会丢失「每个中间提交何时发生、谁做的」——这是已知代价，接受它，因为 `main` 上要读的是「发生了什么」，不是「怎么走过来的」。中间过程留在 PR 里。

## 提交与 PR 标题

格式（Conventional Commits，描述用中文，与现有历史一致）：

```
<type>: <描述>
<type>(<scope>): <描述>
<type>!: <描述>              # 不兼容改动
```

| type | 用于 | 对版本的影响 |
|---|---|---|
| `feat` | 新增能力 | MINOR |
| `fix` | 修 bug | PATCH |
| `docs` | 文档 / spec / README / CHANGELOG | 无 |
| `test` | 只动测试 | 无 |
| `chore` | 构建、依赖、书签式维护 | 无 |
| `refactor` | 行为不变的重构 | 无（除非真改了行为） |
| `perf` | 性能 | PATCH（无 API 变化时） |
| `ci` | `.github/**` | 无 |

三条硬规则：

1. **PR 标题必须符合上面的格式**——squash 时它默认就是合并后的提交标题。但**默认规则分两种情况**：PR 只有 **1 个提交**时，默认取**那个提交的标题与正文**；**2 个及以上**才取 PR 标题（[官方说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests)）。所以「分支上的提交随便写」只在 ≥2 个提交时成立：一个提交叫 `wip`、PR 标题写 `fix: 修复配对` 的单提交 PR，默认仍会把 `wip` 合进 `main`。两道兜底都要做——仓库把默认 squash message 设成 **Pull request title**（见 D3），合并时再看一眼最终标题。
2. **不使用 `commitlint` 或任何 hook 强制**：本仓库的提交由 AI 按批次计划生成（`.trellis/workflow.md` Phase 3.4），失败一次就阻塞整个流程，收益不足以抵。靠 PR 标题 + review 约束。
3. **不 amend 已推送的提交**，也不 rebase 已推送的分支（与 Phase 3.4 的 `No git commit --amend` 一致）。

`BREAKING CHANGE` 用 type 后的 `!` 标记（`feat!:`），不用 footer 形式——一行能说清的事不占三行，且 squash 后 footer 容易在编辑中被丢掉。

## 维护分支：现在还发布不了，先别建

三个条件**同时**成立才**考虑**建：

1. 旧版本（如 `0.1.x`）已被外部使用，不能强制升级；
2. `main` 上已经有不兼容改动，不适合直接把补丁合进去；
3. 确实要发一个只含该补丁的旧版本号。

这三条只说明存在维护需求，**不代表发布支持已经就绪**。当前发布脚本有一个硬编码映射：

```js
dist_tag: prerelease ? 'next' : 'latest',   // scripts/prepare-release.mjs:64
```

所有正式版都落到 `latest`。已经发布过 `0.2.0` 之后再发 `0.1.2`，默认安装就会回到 `0.1.2`：该次 `npm publish --tag latest` 会移动 `latest`，npm 不会因版本较旧而保留原指向。GitHub Release 侧也必须显式指定维护版 `--latest=false`。

允许建立维护线之前，要先确定发布策略并完成支持改造：

| # | 前置条件 | 验证要求 |
|---|---|---|
| 1 | 修改 `prepare-release.mjs` 的 dist-tag 判定与对应测试，区分当前稳定线和维护线 | 维护版不得输出 `latest`；当前稳定线仍按既定规则发布 |
| 2 | 确定维护版本的 dist-tag（例如 `maintenance` / `legacy`），并让维护版 GitHub Release 使用 `--latest=false` | dist-tag 不得是 semver 范围；本地干跑和测试覆盖维护版映射与 Release 参数 |
| 3 | 将上述支持整理为可独立回植的提交，并列明 workflow、脚本、测试及其依赖 | 新建维护线后必须回植并验证；只改 `main` 不算维护线具备发布能力 |

当前方案是在 `npm publish --tag <维护通道>` 时直接设定 dist-tag。若将来另选「发布后再移动 dist-tag」，必须先修改本条约定、评估 `latest` 临时指错的影响，并核对 npm Trusted Publisher 的 **Allow npm dist-tag** 权限；本草案不采用这条替代路径。

维护版本不进 `latest` 仍可按精确版本或维护通道安装。对于不包含新稳定线的范围（如 `^0.1.0`），npm 仍可解析到满足范围的 `0.1.2`。

发布策略和支持改造就绪之前，**不建立维护线，也不从维护线发布**。回植只能在分支创建后完成，因此创建分支不等于允许立刻打发布标签；必须通过下面的维护线验收。

### 支持改造就绪后：回植、验证、再发布

从旧 tag 切出的分支不会自动带上 `main` 的发布改造。自动 tag 发布使用标签提交里的 workflow；手工重跑也会 checkout `refs/tags/<tag>`，执行该标签内的发布脚本。因此要核对**维护标签实际包含的发布逻辑**。

以下是未来支持维护线后的操作示例，当前不能直接执行；推送仍按「推送授权」由人执行。

```bash
git switch -c release/0.1 v0.1.1
# 先回植发布支持及其依赖，再挑修复；不要把 main 整体合进来
git cherry-pick <release-support-commit>
git cherry-pick <fix-commit>

# npm 的 version lifecycle 同步 dsh.plugin.json
npm version 0.1.2 --no-git-tag-version
# 编辑 CHANGELOG.md，补齐非空的 "## v0.1.2 — YYYY-MM-DD" 段落
git diff HEAD -- package.json dsh.plugin.json CHANGELOG.md

npm run check:syntax
npm test
npm pack --dry-run
node scripts/prepare-release.mjs v0.1.2 .release-dry-run
# 核对 metadata.json：version=0.1.2、prerelease=false、dist_tag 为约定维护通道
# 核对 notes.md 为本次维护补丁；workflow 对维护版使用 --latest=false
# 维护线测试须覆盖：发布支持已回植、维护版不输出 latest、当前稳定线映射保持正确

# 以上验证通过后，按提交计划提交清单与发布说明，再打标签
git add package.json dsh.plugin.json CHANGELOG.md
git commit -m "chore: 准备维护版本 0.1.2"
git tag -a v0.1.2 -m "Release v0.1.2"
# 以下推送命令仅供人执行
git push --atomic origin release/0.1 v0.1.2
```

**放行条件**：发布支持及依赖已存在于维护线；两份清单与 tag 版本一致；发布说明非空；上述检查通过；干跑输出为维护通道。缺少回植、输出仍为 `latest`、版本不一致或缺少发布说明时，均不得打发布标签。

### 回流：不能 `git merge`

维护分支与 `main` 通常已经分叉，`git merge release/0.1` 会产生 merge commit，与「只用 squash」和「Require linear history」直接冲突（后者会把它挡在门外）。

修复要**重新落到 `main` 的线性历史上**：

```bash
git switch -c fix/<same-fix> origin/main
git cherry-pick <fix-commit>
# 按 A 节判据：走 squash PR，或（仅当不碰发布链路时）直推
```

两条排除项：

- 维护线的**版本号**改动（`package.json` / `dsh.plugin.json`）不要回流——`main` 的版本号比它新；
- 维护线的 **CHANGELOG 段落**（`## v0.1.2 — …`）不要回流——`main` 的 CHANGELOG 里不该出现一个比当前版本更旧的条目。

## 常见错误

- **为了「规范」给每个改动都开分支，然后忘了删。** 分支的唯一价值是合并前的 CI；没有 PR 的分支只是垃圾。
- **PR 标题写成 `update`、`fix stuff`。** squash 之后这就是 `main` 的历史。
- **单提交 PR 用 `wip` 当提交标题，以为 PR 标题会覆盖它。** 默认不会——单提交时默认取提交标题。
- **squash 合并一个 20 提交的 PR，却指望能 `git bisect` 到中间状态。** 中间状态在 PR 里，不在 `main` 上。
- **在维护分支上合并 `main`。** 那会把新功能带进旧版本；只 cherry-pick。
- **以为「打个标签就能发维护版」。** 会跑起来，但会改掉默认安装的版本，见本文维护分支一节。
- **把 `release/0.1` 当长期分支一直留着。** 那条线停止维护时就该删。

## 验证命令

```bash
git log --oneline -20                              # 是否全为线性、前缀合规的单行
git branch -a                                      # 是否有遗留的已合并分支
git log --merges --oneline origin/main -10         # 空输出 = 没有 merge commit
```
````

---

# B. `release/versioning.md`（草案全文）

````markdown
# Versioning

> 「这次改动该升哪一位」的判定表。标签文法见 [Tag & Release](./tag-and-release.md)，本文只管语义。

---

## 前提：这里是 0.x

semver 对 0.y.z 的定义是 `Anything MAY change at any time`（[semver.org](https://semver.org/)）。本仓库停在 `0.x` 不是因为「还没做完」，而是因为 README 明写「阶段 6 真机验证未执行」、面板 API 仍在变动——`1.0.0` 会给出一个目前不成立的兼容性承诺。

**`1.0.0` 的触发条件**（全部满足才升）：

- 面板 HTTP API 与配对流程在一次发布里没有变化；
- `dsh.plugin.json` 的配置项语义稳定；
- README 里「未真机验证」的声明被删除（即真的有人走完扫码 → 会话 → 流式 → 停止）。

## 判定表

| 改动 | 版本位 | 说明 |
|---|---|---|
| 抬高 `engines.dsh` 下限 / 放弃旧宿主支持 | **MINOR**（1.0 后 MAJOR） | 旧宿主上装了也跑不起来 = 不兼容 |
| 删除、重命名配置项；或改默认值导致旧行为反转 | **MINOR** | 用户配置失效或行为变了 |
| 改 `cordis.patch.yml` 的 bundle patch；改 `src/index.js` / `src/client.js` 的导出入口 | **MINOR** | 宿主加载契约变了 |
| 新增面板 Tab、新增 API 字段、新增可选配置（默认行为不变） | **MINOR** | 向后兼容的新能力 |
| 修 bug、改文案、不改契约的性能/安全修补 | **PATCH** | |
| 只改 `README` / `CHANGELOG` / `docs/` / `.trellis/` | **不发版** | 没有对用户可见的产物变化 |
| 安全修复（含需要 breaking 的） | 按影响面定，但**优先发** | semver 允许「为了用户利益打破排法」，见下 |

两条补充：

- **不兼容改动用 MINOR 表达**（`0.1.x → 0.2.0`）是**本仓库约定，不是 semver 强制**。semver 只说 0.y.z 可以随便变；本仓库选 `0.1.0` 起步，就必须让 `0.2.0` 承载 breaking，否则版本号失去信息量。写成约定的另一个好处：AI 不必猜。
- **弃用要跨两个版本**：先发一个 MINOR 声明弃用（README + CHANGELOG 的 `Deprecated` 段），再在下一个 MINOR（1.0 后是 MAJOR）删除。

## 预发布

| 标签 | dist-tag | Release 形态 |
|---|---|---|
| `vX.Y.Z` | `latest` | 普通 Release，默认可成为 Latest |
| `vX.Y.Z-alpha.N` / `-beta.N` / `-rc.N` | `next` | `--prerelease --latest=false`，不动 Latest |

- 预发布**只用于**「想让人先试、但还不能替代 `latest`」的版本。修 bug 后重发一个正式版更简单，不要用 `-beta` 躲避正式发布。
- 预发布的优先级由 semver 定义：`alpha < alpha.1 < beta < beta.2 < rc.1 < 正式`。`v0.2.0-beta.11 > v0.2.0-beta.2`（数字段按数值比，不是字符串比）。
- **不用 build metadata**：`v0.2.0+build` 是合法 semver，但本仓库的标签正则**故意不收**（`prepare-release.mjs`），因为 build metadata 不参与优先级，落到 npm 上没有意义。

## dist-tag 的三条硬规则

1. **dist-tag 在 publish 那一刻设定**（`npm publish --tag <tag>`），不跑 `npm dist-tag add`。这不只是风格：npm 侧 Trusted Publisher 的 "Allow npm dist-tag" 开关对应的是**单独管理** dist-tag 的权限，本流水线不需要它。
2. **dist-tag 名不能看起来像 semver 范围**（npm 会拒绝）。`next` `beta` `canary` 安全；`v1.4` 会被解释成 `>=1.4.0 <1.5.0` 而报错。
3. **「正式版」不等于「永远 `latest`」。** 现在 `prepare-release.mjs:64` 把「非预发布」直接映射成 `latest`，这在只有一条版本线时成立；一旦引入维护分支，它会让默认安装**倒退**（npm 的 `latest` 跟发布时间走，不比版本大小）。维护版本的策略见 [Branch & Merge](./branch-and-merge.md#维护分支现在还发布不了先别建)。

## 发版第一步：把 `Unreleased` 改名

`CHANGELOG.md` 当前有 `## Unreleased` 段，而 `prepare-release.mjs` 只认 `## vX.Y.Z — YYYY-MM-DD`。发版的第一件事是：

```bash
# 把 "## Unreleased" 改成 "## v0.2.0 — 2026-10-21"
# 并在顶部补一个新的 "## Unreleased"
```

顺序不能反：**先改名再打标签**。改了名字却没打标签只是一个未发布的提交，不会触发任何东西；打了标签却忘了改名，发布会因「找不到段落」被拒。

## 常见错误

- **拿 `1.0.0` 当「我们很成熟」的徽章。** 它是兼容性承诺，不是纪念章。
- **修个 bug 顺手升 MINOR。** 版本号是给消费方做决策用的，不是给维护者记功用的。
- **为了绕开「版本已存在」而改版本号重发。** 那是发两个版本，见 [Tag & Release](./tag-and-release.md#幂等与重试)。
- **发版后补写 CHANGELOG。** Release 正文是从那里读的，见 [Tag & Release](./tag-and-release.md#changelog-契约)。
````

---

# C. 对现有文件的修订

## C1 `release/index.md`

`Guidelines Index` 表新增两行：

```markdown
| [Branch & Merge](./branch-and-merge.md) | 分支模型与命名、PR 判据、squash 合并、提交与 PR 标题规范、维护分支触发条件 | Done |
| [Versioning](./versioning.md) | 0.x 语义、bump 判定表、预发布与 dist-tag、弃用流程、`Unreleased` 改名步骤 | Done |
```

`Pre-Release Checklist` 第 3 条前插入一条：

```markdown
- [ ] `CHANGELOG.md` 的 `## Unreleased` 已改名为 `## vX.Y.Z — YYYY-MM-DD`（`prepare-release.mjs` 只认后者）
```

## C2 `release/tag-and-release.md`

| 位置 | 修订 |
|---|---|
| 第 181 行 | 「这个 **31** 没有测试守着」→「这个 **33** 没有测试守着」（实测 `npm pack --dry-run --json` 为 33，同文件第 179 行与 `docs/RELEASING.md` 均为 33） |
| 「dist-tag 与 Release 形态」一节末 | 解释 `--prerelease --latest=false`：分别表达候选版本性质与显式不作为 Latest 的项目策略；不以自动判定作为发布策略 |
| 新增一节「Immutable releases 的前置条件」 | 见下 |

追加节草案：

```markdown
## Immutable releases：要先改的是重试状态机

GitHub 的 [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) 一旦开启：
- 标签锁死，**不能在 Release 存在期间移动或删除**；
- 资产**不可修改、不可删除**；
- 删除 Release 后可以删标签，但**同名标签永久不可复用**。

一个常见的误判：以为要把 `gh release create` 拆成三步手写 draft-first。不需要——[gh 手册](https://cli.github.com/manual/gh_release_create)写明，带资产创建时它**内部就是**「建 draft → 传资产 → publish」：

> When using the `create` command to attach assets to a release, separate API calls are made to create the release as a draft, upload the assets, and then publish the release.

真正的冲突在**重试**。现在 `npm-publish.yml` 只区分两种状态：

    if gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
      gh release upload "$RELEASE_TAG" "$TARBALL" --clobber     # ← 已发布的 immutable release 上必然失败
    else
      gh release create "$RELEASE_TAG" "$TARBALL" --verify-tag ...
    fi

开启 immutable 之后必须区分**三种**：

| 状态 | 判据 | 行为 |
|---|---|---|
| 不存在 | `gh release view` 失败 | `gh release create`（内部 draft → 传 → publish） |
| 存在但未发布（draft，上次中断） | `--json isDraft` 为 `true` | draft 仍可改：`gh release upload --clobber` 到 draft，**再 `gh release edit --draft=false`** |
| 已发布 | `--json isDraft` 为 `false` | **只校验，不写**：比对 Release 资产与 `npm view … dist.integrity`，一致即视为成功；不一致就中止交人。**不能 `--clobber`，也不能删 Release**（删了 tag 名作废） |

第二种是最容易卡住的地方：上传中断会留下一个 draft，而 `gh release view` 对 draft 同样成功，于是重跑走进「已存在」分支去 `--clobber`——`--clobber` 本身能成功，但**后面没有 publish 步骤**，Release 就永远停在 draft，而 npm 上版本早已发布，没人会再触发一次。

**启用 immutable 的验收条件**（是条件，不是建议）：

1. 三种状态各有确定行为，「已发布」状态**不存在**任何 `--clobber` 路径；
2. 同一个 tag 从任意状态重跑，都能收敛到「已发布且资产正确」；
3. 这条路径有测试，或至少有一次针对 draft 状态的人工演练记录（`--draft` 手工造一个再重跑）。

**当前状态：未核验。目标配置：完成上述前置改造与验收前保持关闭。** 实际开关需核对 `research/03-gap-analysis.md` 的 C3 项，并记录核验人、时间与证据；若发现已经开启，应先处理当前重试路径的兼容问题，不能继续假设它处于关闭状态。
```

---

# D. GitHub 侧配置清单（草案，待人工执行）

> **本节全部内容本地不可验证。** 本机没有 `gh`，也没有远端 API 访问；以下每一条都要在 GitHub 页面上核对后生效，核对之前文档不得写成「已启用」。

## D1 `main` 的 branch ruleset

### 包 1：与当前直推流程相容的基础保护

Settings → Rulesets → **New branch ruleset**，target `refs/heads/main`：

| 规则 | 设成 | 理由 |
|---|---|---|
| Restrict deletions | ✅ | 禁止删除 `main` |
| Block force pushes | ✅ | 禁止改写主线历史 |
| Require linear history | ✅ | 禁止向主线推入 merge commit |
| Bypass list | **留空** | 管理员日常操作也受上述三条约束；普通线性直推不需要 bypass |

上述三条都不要求提交预先取得 check 结果，符合规则的直推仍可进行。不要为了将来可能发生的分支改名而常驻 Repository admin bypass；确需改名等维护操作时，单独评估并临时调整相关规则，记录原因，完成后恢复。

### 包 2：当前暂不开启，分别说明前置条件

| 规则 | 开启前要具备什么 | 当前选择 |
|---|---|---|
| Require a pull request before merging | 统一通过 PR 更新 `main`，同步移除 A 节的直推路径 | 暂不开 |
| Require status checks to pass（勾 strict） | 更新 `main` 前，同一目标 SHA 已通过所需检查；strict 还要求满足与最新 base 同步的要求 | 暂不开；当前尚无直推提交的预先检查流程 |
| Restrict commit metadata | 接受 squash PR 的全部 head 提交也须符合 metadata 约束 | 不启用；与分支 WIP 提交习惯冲突，和是否统一走 PR 是两项独立选择 |

**Required checks 可以与直推共存**：同一 SHA 可先在其他分支取得检查结果，再推入受保护的 `main`（[官方说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)）。检查通过后如果 rebase、amend 或另做 squash 导致 SHA 改变，旧结果不能代替新提交的检查。

当前 `ci.yml` 自动运行于 push `main` 与 PR，并保留 `workflow_dispatch`；尚未定义并验证「其他分支预先检查同一 SHA → 推入 main」的步骤。因此本仓库当前不开 required checks，这是**流程选择**，不是 GitHub 的机制限制。以后可以统一走 PR，也可以先补齐同一 SHA 的预先检查；不得靠 admin bypass 冒充检查已通过。

### 当前选择与后续触发条件

- 保留 A 节定义的有限直推路径，启用包 1 时不设置永久 bypass。
- `npm-publish.yml` 在 publish 前重跑 syntax / test / pack，能拦住这些检查检测到的问题；不能由此推断所有坏提交都发不出去。
- 没有 required checks 时，`main` 的合入质量仍依赖本地验证与人工流程；包 1 提供的是删除、历史改写和 merge commit 方面的约束。
- 出现第二个提交者或开始接受外部 PR 时，重新评估统一走 PR 并启用 required PR + checks；选择该路径就同步移除 A 节的直推项。**Restrict commit metadata 仍不默认启用。**

## D2 `v*` 的 tag rulesets

创建权限与已存在标签的保护必须拆成两个 ruleset，均 target `refs/tags/v*`。Bypass 针对整个 ruleset，不是只豁免其中一行。

| Ruleset | 规则 | Bypass list | 目标 |
|---|---|---|---|
| `release-tag-integrity` | Restrict updates ✅；Restrict deletions ✅ | **留空** | 发布者和管理员也不能移动或删除已有发布标签 |
| `release-tag-creation` | Restrict creations ✅ | Repository admin（当前人工发布账号所用角色） | 仅显式列入 bypass 的发布身份可以创建匹配的标签 |

发布身份只能绕过 `release-tag-creation`；它仍受没有 bypass 的 `release-tag-integrity` 约束。核对时检查两个 ruleset 的目标、Active 状态与 bypass list，并检查是否还有叠加的其他规则。

**Owner 没有天然的 ruleset 豁免。** 是否可以绕过规则取决于该规则集的 bypass 配置。GitHub 按账号、角色或 App 身份授权，无法区分使用同一凭据的人和 AI；所以「创建权限授予人工发布账号」不等于机制上保证「只有人能创建」。现有「推送授权」约束继续有效。

## D3 仓库设置

| 位置 | 设置 | 理由 |
|---|---|---|
| Settings → General → Pull Requests | 只允许 **Squash merging**，关掉 Merge / Rebase | 与 A 节「只用 squash」一致 |
| 同上 → Allow squash merging 的默认消息下拉 | 选 **Pull request title** | 默认值对**单提交 PR** 取的是那个提交的标题，会把 `wip` 带进 `main`（A 节规则 1） |
| 同上 | ✅ Automatically delete head branches | 分支生命周期 |
| Settings → Releases | `Enable release immutability` **暂不勾**，除非先满足 C2 的三条验收条件 | 冲突见 C2 |

## D4 核对命令（需先装 `gh` 并登录）

```bash
gh auth login
gh api repos/Misaka10091/dsh-remote-control/rulesets --jq '.[].name'
gh api repos/Misaka10091/dsh-remote-control/rulesets/<id> --jq '{name,enforcement,conditions,bypass_actors,rules}'
# 某个 Release 的形态（注意：--json 没有 isLatest 字段）
gh release view v0.1.1 --json tagName,isDraft,isPrerelease,isImmutable,assets \
  --jq '{tagName,isDraft,isPrerelease,isImmutable,assets:[.assets[].name]}'
# Latest 只能从 releases/latest 取
gh api repos/Misaka10091/dsh-remote-control/releases/latest --jq .tag_name
```

`gh release view --json` 的可用字段是 `apiUrl` `assets` `author` `body` `createdAt` `databaseId` `id` `isDraft` `isImmutable` `isPrerelease` `name` `publishedAt` `tagName` `tarballUrl` `targetCommitish` `uploadUrl` `url` `zipballUrl`——**没有 `isLatest`**，写上去会直接报错。

装不了 `gh` 时，等价做法是逐条在 Settings 页面截图核对 D1–D3。

---

# 落地顺序建议（下一个任务）

1. **先定维护分支是否要做**。要做，先确定维护通道并改好发布脚本、workflow 和测试，再将支持及依赖回植到维护线；以维护标签中的脚本干跑和三方版本一致为验收依据。不做，就明确写「当前不支持维护版本」。
2. 核验 immutable 的实际状态，并在文档里分开记录「实际状态」与「目标配置」。目标是在重试状态机改造完成且 C2 三条验收通过前保持关闭；若实际已开启，先处理兼容问题。
3. 新建 `branch-and-merge.md` + `versioning.md`，更新 `index.md`（A、B、C1）。
4. 修 C2 的两处文档缺陷（31→33、`Unreleased` 改名步骤）。
5. 由人在 GitHub 上核对并配置 D1 的包 1、D2 的两个 tag ruleset 和 D3，核对每条 ruleset 的 enforcement、目标、bypass 及叠加规则；将结果记录到 `docs/RELEASING.md`，不把尚未核验的设置写成 spec 的既成前提。
