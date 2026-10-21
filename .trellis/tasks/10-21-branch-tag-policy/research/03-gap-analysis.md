# 03 · 与本仓库的差距分析

> 左列是**核实过**的仓库现状（怎么核实的写在括号里），右列是对照 `01` / `02` 得出的建议。
> 凡是本地无法核实的东西，一律进最后一节「待人工确认」，不写成事实。

---

## 1. 现状快照（可核实部分）

| 维度 | 现状 | 核实方式 |
|---|---|---|
| 远端 | `origin` = `git@github.com:Misaka10091/dsh-remote-control.git` | `git remote -v` |
| 分支 | 只有 `main`（本地与 `origin/main` 同步，无 `release/*`、无 `develop`） | `git branch -a` |
| 标签 | `v0.1.0`（**轻量标签**，`objecttype=commit`）、`v0.1.1`（annotated，tagger = Misaka10091） | `git for-each-ref refs/tags` |
| 提交风格 | 全部直推 `main`，线性无 merge commit；前缀实际在用 `feat:` `fix:` `docs:` `chore:` `test:`，描述是中文 | `git log --oneline -25` |
| 签名 | **未配置**（无 `tag.gpgSign`、无 `commit.gpgsign`；本地 `user.name=dsh`、`user.email=…@users.noreply.github.com`） | `git config --local/--global --list` |
| CI | `.github/workflows/ci.yml`：`push: main` + `pull_request` + `workflow_dispatch`，job 名 `test`，三条 gate（`check:syntax` / `test` / `pack --dry-run`），无 secret | 读 workflow |
| 发布 | `.github/workflows/npm-publish.yml`：仅 tag `v[0-9]*.[0-9]*.[0-9]*` 与 `workflow_dispatch` 触发；OIDC；Release 已存在时 `gh release upload --clobber` | 读 workflow 第 104–112 行 |
| CHANGELOG | 手写；当前有 `## Unreleased` 段；发布段格式 `## vX.Y.Z — YYYY-MM-DD`，正文逐字进 Release | `CHANGELOG.md` 第 5–7 行 |
| 打包 | **实测 33 个文件** | `npm pack --dry-run --json` → `files.length = 33` |
| 文档 | `docs/RELEASING.md`（人读）+ `.trellis/spec/release/`（agent 读） | 目录 |
| 治理文件 | 无 `CONTRIBUTING.md`、无 PR/issue 模板、无 `CODEOWNERS`、无 `.github/dependabot.yml` | 列 `.github/` 只有两个 workflow |
| 工具 | 本机**未安装 `gh`**，无法用 API 读远端设置 | `gh --version` 失败 |

---

## 2. 差距表

### 2.1 分支模型与命名

| 现状 | 差距 | 建议 | 采纳 |
|---|---|---|---|
| 只有 `main`，历史提交全部直推 | 没有分支命名约定；新增贡献者（或未来的 AI 会话）没有可遵循的切分支规则 | 定义 `<type>/<slug>`，`type` 复用提交类型词表（`feat` `fix` `docs` `chore` `refactor` `test` `ci`），slug 用小写连字符 | ✅ |
| 无分支生命周期规则 | 分支建了不删 | 合并即删；GitHub 侧开 "Automatically delete head branches" | ✅ |
| 无 release 分支 | — | **不引入**。只有一条 `0.x` 版本线，tag 已足够表达发布 | ✅ 明确写「何时才需要」 |
| `main` 可直推 | 与 GitHub Flow 冲突，但仓库实际在直推 | 规范写「小改动可直推，改动跨多个文件或涉及发布链路时走 PR」，并说明这条是**现状的诚实描述**，不是最佳实践 | ✅ |

### 2.2 保护规则

| 现状 | 差距 | 建议 | 采纳 |
|---|---|---|---|
| 远端 ruleset 状态**未知**（尚未核验） | 未确定哪些目标保护已实际生效 | `main` 当前目标为禁删、禁强推、线性历史且无永久 bypass；required PR / checks 暂不开，后续先确定 PR 或同一 SHA 预先检查流程 | ✅ 记录目标配置，与远端实际状态分开 |
| tag ruleset 状态**未知**，轻量标签本身不能证明有无保护 | 标签是发布触发器，需要核对创建权限及禁止改写/删除的约束 | 拆分 `release-tag-creation` 与 `release-tag-integrity`：前者给发布角色 bypass，后者 bypass 留空 | ✅ 待人工核验现有规则后配置 |
| `v0.1.0` 是轻量标签 | 已有偏差 | 不重建（现有 spec 已定这条），草案继续沿用 | ✅ 沿用 |
| 本地未配签名 | 当前提交链路不具备 signed commits 前提 | **不开启**；将来先配置并验证签名链路，再评估远端规则 | ✅ 记录为可选前置 |
| 「AI 不得推送」靠授权流程约束 | GitHub 无法区分使用同一凭据的人和 AI；owner 也没有天然 ruleset 豁免 | 规则按其 bypass list 生效；保留既有授权流程，不宣称 ruleset 可以识别人机 | ✅ |

### 2.3 合并与提交

| 现状 | 差距 | 建议 | 采纳 |
|---|---|---|---|
| 线性历史，无 merge commit | 没有明文禁止 merge commit | 合并方式定为 **squash**，并开 "Require linear history" 兜底 | ✅ |
| 提交前缀在用但无成文规范 | 没有 type 词表、没有「PR 标题即提交信息」的说明 | 词表：`feat` `fix` `docs` `test` `chore` `refactor` `ci` `perf`；格式 `<type>: <中文描述>`；PR 标题必须同格式 | ✅ |
| — | `BREAKING CHANGE` 在 0.x 下的用法没写 | 用 `!` 或 footer 标记 + MINOR bump（见 2.4） | ✅ |
| — | 强制 CC 的代价（squash 时要求 head 分支每个提交都合规） | **不启用** "Restrict commit metadata"，只用流程约束，理由写进草案 | ✅ 不采纳，给理由 |

### 2.4 版本语义

| 现状 | 差距 | 建议 | 采纳 |
|---|---|---|---|
| 只有标签**文法**（正则） | 没有「什么改动升哪一位」的规则 | 补 bump 判定表（含 `engines.dsh` 抬高 = MINOR、文档改动 = 不发版） | ✅ |
| `0.1.1` 已发布 | 没写 0.x 阶段 breaking 的排法 | 写明「0.x 用 MINOR 表达不兼容，这是本仓库约定，semver 不强制」 | ✅ |
| dist-tag 映射已在 `prepare-release.mjs` 实现 | ① 文档没解释为什么 `next` 安全、`v1.4` 不安全；② **映射本身把「所有正式版」都写成 `latest`（第 64 行），引入维护分支后会令默认安装倒退** | ① 引用 npm 规则；② 先完成维护通道支持，建线后回植 workflow、脚本、测试及依赖；核对维护标签的干跑输出、版本和发布说明 | ✅ |
| — | 弃用流程没写 | 一句话：先 MINOR 声明弃用，再下个 MINOR（1.0 后 MAJOR）删除 | ✅ |

### 2.5 Release 形态

| 现状 | 差距 | 建议 | 采纳 |
|---|---|---|---|
| immutable releases 状态**未核验** | 当前 `gh release upload --clobber` 与已发布的 immutable Release 不兼容；代码不能证明远端开关状态 | 先核对 C3；目标配置是在三状态重试和验收就绪前保持关闭，若实际已开则先处理兼容问题 | ✅ 区分实际状态与目标配置 |
| Release 由 `gh release create … --verify-tag` 一步创建 | 现状**没有**遗漏 draft 步骤（gh 内部就是 draft → 传 → publish），真正的缺口是重跑时把 draft 误判成「已发布」 | 不现在改 workflow；把三状态写进 spec 的验收条件 | ✅ 记为前置条件，不动代码 |
| prerelease 已带 `--prerelease --latest=false` | 缺少候选版本标记与显式 Latest 策略的解释 | 保留两参数，明确预发布不作为 Latest 的项目策略 | ✅ |
| npm provenance 由现有 OIDC 发布路径生成；release attestation 状态未核验 | 两者易被混说，且不能从代码推断远端 attestation 状态 | 增加「谁生成 / 证明什么」对照表，核对 immutable 开关及具体 Release | ✅ |

---

## 3. 不采纳项与理由

| 候选做法 | 为什么不采纳 |
|---|---|
| **changelog 自动生成**（release-please / semantic-release / changesets） | 本仓库的 CHANGELOG 段落是**逐字**进 GitHub Release 正文的人工契约，且要追加固定的 `--profile web` 安装段。自动生成会同时破坏段落格式与安装命令，而这两件事各有测试守着（`tests/release.test.mjs`）。收益（省一次手写）远小于风险。 |
| **merge queue** | 单 maintainer，无并发合并排队问题；开启后还会接管 merge 方式，与「squash + 线性历史」的显式选择冲突。 |
| **`release/x.y` 维护分支** | 只有一条 `0.x` 线且无并行维护需求。更关键的是：**现在建了也发不出去**——`prepare-release.mjs:64` 把一切正式版映射为 `latest`，从旧线发 `0.1.2` 会把默认安装拉回旧版本。规范应写清「触发条件 + 三个前置改造」，而不是只写「什么时候建」 |
| **`develop` / `next` 长期分支** | 预发布已经由标签表达（`v0.2.0-beta.1` → dist-tag `next`）。再加一条分支会产生第二套事实源。 |
| **开启 signed commits** | 本机没有 GPG/SSH 签名配置。现在开启会让当前提交链路直接失败，属于「为了合规破坏可用性」。记录为将来可选项。 |
| **强制 commit metadata（ruleset）** | squash 合并要求 head 分支每个提交都合规，会与「一个任务一串 WIP 提交」的现有习惯冲突。用 PR 标题约束即可达到同样效果。 |
| **NPM_TOKEN 兜底** | 与现有 OIDC 设计冲突；现有 spec 已明确「出现 secret 引用即是回归」。 |

---

## 4. 待人工确认（本地无法核实）

> 本机没装 `gh`，也没有远端 API 访问；下面每一条都只能由人在 GitHub 页面上核对。**在核对之前，任何文档都不能把它们写成「已启用」。**

| # | 要确认什么 | 怎么确认 | 影响哪条结论 |
|---|---|---|---|
| C1 | `main` 上是否已有 ruleset / branch protection | Settings → Rulesets；或 `gh api repos/Misaka10091/dsh-remote-control/rulesets` | 2.2 的「应配置项」是新增还是补强 |
| C2 | `v*` 是否有 tag ruleset | Settings → Rulesets → 筛选 Tag | 2.2 的标签保护 |
| C3 | 是否启用 immutable releases | Settings → Releases 段 → `Enable release immutability` 是否勾选 | 2.5 的 `--clobber` 冲突是否**已经**成立 |
| C4 | 仓库允许哪些合并方式、squash 默认消息是否为 Pull request title | Settings → General → Pull Requests | 只允许 squash；确保单提交与多提交 PR 均默认使用 PR 标题 |
| C5 | "Automatically delete head branches" 是否开启 | 同一页面 | 分支生命周期 |
| C6 | 要求的 status check 在 UI 里的准确名字 | 任取一个 PR 的 checks 列表（当前 workflow `ci` / job `test`） | 草案里写哪个名字当 required |
| C7 | `0.1.1` 的 GitHub Release 是否已存在、是否被标 Latest | Releases 页面 | 与「第 4 层从未真跑过」的既有结论是否仍然成立 |

---

## 5. 顺手发现的既有文档问题（与本任务主题无关，但改动 spec 时应一并修）

| 文件 | 问题 | 证据 |
|---|---|---|
| `.trellis/spec/release/tag-and-release.md` 第 181 行 | 写「这个 **31** 没有测试守着」，同文件第 179 行写的是 33，`docs/RELEASING.md` 也是 33 | `npm pack --dry-run --json` 实测 `files.length = 33` |
| `.trellis/spec/release/index.md` 第 67 行 | 同样引用 33（正确），但与上面那处矛盾 | 同上 |
| `CHANGELOG.md` | 有 `## Unreleased` 段，而 `prepare-release.mjs` 只认 `## vX.Y.Z — `；发版时若忘了改名，发布会因「找不到段落」被拒 | 读 `CHANGELOG.md` 第 7 行 + 既有 spec 的「CHANGELOG 契约」 |

第二条不是 bug，是**流程步骤**：发版第一步应是「把 `## Unreleased` 改成 `## vX.Y.Z — YYYY-MM-DD`」。现有 spec 没写这一步，草案应补上。

---

## 6. 结论

1. 当前实践与目标配置应分开写：提交前缀和线性历史已有本地依据；PR 标题作为统一 squash 默认来源，仍需要设置 **Pull request title** 并核对最终标题。
2. `main` 基础保护不设永久 bypass；发布标签的创建权限和禁止更新/删除拆为两个 ruleset。它们约束 GitHub 身份与操作，不能区分使用同一凭据的人与 AI，不能替代「推送授权」。
3. Immutable 开关及具体 Release 状态尚未核验；目标是完成三状态重试与验收后才启用。若远端已经开启，应先处理重试兼容问题。
4. 支持维护版本需先完成通道策略与发布支持，再在旧 tag 切出的维护线上回植 workflow、脚本、测试及依赖，升号、写说明并干跑。验收检查维护标签里的实际逻辑，不能用 `main` 已改好代替。
5. 版本语义仍需补入正式规范：既要定义标签文法，也要定义 bump、维护通道和弃用规则。本任务保持草案状态。
