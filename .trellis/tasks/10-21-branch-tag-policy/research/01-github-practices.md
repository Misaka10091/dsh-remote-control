# 01 · 分支模型、保护规则、合并与提交规范

> 外部实践梳理。每节结尾的「对本仓库意味着什么」是结论，其他内容只有在能支撑结论时才写。
> 来源只取官方文档（docs.github.com / git-scm / conventionalcommits.org），二手博客不进正文。

---

## 1. 分支模型

### 1.1 GitHub Flow（GitHub 官方推荐给多数项目）

[GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow) 的六个动作，顺序即规则：

1. **建分支**——官方原话是「short, descriptive branch name」，例子是 `increase-test-timeout`、`add-code-of-conduct`；
2. 改代码并提交、推送；
3. **开 PR**（想早收反馈就开 draft）；
4. 处理 review；
5. 合并；
6. **删分支**——「delete your branch … prevents you or others from accidentally using old branches」。

两个容易被忽略的点：

- 官方明确说「一个不相关改动一个分支」（`Make a separate branch for each set of unrelated changes`），理由不是洁癖，而是「一组改动卡住时不会拖住另一组」。
- 删除分支是**流程的一部分**，不是清理癖。分支删除后 PR 与提交历史都还在，可恢复（[Deleting and restoring branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-pull-request)）。

GitHub Flow 的隐含前提是「`main` 永远可发布」。它没有 release 分支的概念，发布靠 tag。

### 1.2 git.git 的集成分支模型（什么时候才需要维护分支）

[gitworkflows(7)](https://git-scm.com/docs/gitworkflows) 描述的是 Linux 内核量级的模型：`maint`（下一个维护版本）/ `master`（下一个功能版本）/ `next`（待稳定）/ `seen`（还没准备好）。对本仓库真正有用的只有三条：

| 规则 | 原文要点 | 适用性 |
|---|---|---|
| 向上合并 | `Always commit your fixes to the oldest supported branch that requires them.` 然后周期性 merge upwards | 只有存在多个受支持版本线时才成立 |
| topic 分支从最老的集成分支切 | `Fork it off at the oldest integration branch that you will eventually want to merge it into.` | 单条版本线时等价于「从 main 切」 |
| 维护分支按版本号复制 | `git branch maint-X.Y.(Z-1) maint`，主分支 fast-forward 跟上 | 给**已发布但仍在维护**的旧大版本打补丁时才需要 |

gitworkflows 里还有一条值得抄的细节：打发布标签用 **`git tag -s`（签名标签）**，而本仓库现在用 `git tag -a`（annotated）。两者都是「有对象的标签」，差别只在签名。

### 1.3 对本仓库意味着什么

| 结论 | 依据 |
|---|---|
| **当前不建立 release 分支。** 除了出现旧线维护需求，还要先完成维护通道支持，并在建线后把 workflow、脚本、测试及依赖回植到旧线；只改 `main` 不够 | 1.2 的需求条件目前不成立；发布脚本会从标签提交读取，旧 tag 不含后来的支持改造 |
| **不需要 `next`/`develop` 长期分支。** 现有流水线已经把预发布表达成标签（`v0.2.0-beta.1` → dist-tag `next`），用分支再表达一遍会造成两套事实源 | `npm-publish.yml` 触发条件只有 tag |
| **需要的是短命分支 + PR 的规范。** 但要注意：AI/单人直接把 commit 推到 `main` 现在是合法且被实际使用的（历史里 20+ 个提交都在 `main` 上），规范必须承认这个现实，不能写成「禁止直推」 | `git log --oneline` 全在 `main` |

---

## 2. 保护规则与 Rulesets

### 2.1 branch protection 与 rulesets 的关系

[About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) 把两者的关系讲死了：

- **不是二选一，是叠加。**「Rulesets and branch protection rules can both protect branches… all applicable rules are enforced」，冲突时取**最严格**的那一版（`the most restrictive version of the rule applies`）。
- rulesets 的优势：多条可同时作用于同一分支（branch protection 只能一条）、可切换 enforcement 状态而不删除、**任何有读权限的人都能看到生效中的 rulesets**（`Anyone with read access to a repository can view its active rulesets`）。
- 上限 75 条 ruleset / 仓库；targeting 用 `fnmatch`（`qa/*` 只匹配一层，`qa/**/*` 才匹配多层）。
- 可按 role / team / App 配 **bypass list**；还有「For pull requests only」的 bypass 变体——被加入者不能直推，但可以开 PR 后自己绕过保护合并（保留审计痕迹）。

迁移方向是明确的：GitHub 已经提供 [把 branch protection 自动转成 rulesets](https://github.blog/changelog/2026-08-11-automatically-migrate-branch-protection-rules-to-repository-rulesets/) 的功能。

### 2.2 tag 保护：旧机制已经没了

[Tag protections 于 2024-08-30 正式下线](https://github.blog/changelog/2024-05-29-sunset-notice-tag-protections/)，替代品是 **tag ruleset**。所以在文档里写「开启 tag protection」在今天等同于写一个不存在的开关；必须写「新建 tag ruleset」。

### 2.3 可用的规则（只列对发布仓库有意义的部分）

来自 [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)：

| 规则 | 实际行为 | 对本仓库 |
|---|---|---|
| Restrict deletions | 只有 bypass 者能删 | 分支与标签都要开 |
| Block force pushes | 禁强推；**注意**：开了之后连管理员改/重命名默认分支也会被挡（除非在 bypass list） | 要开 |
| Require linear history | 禁 merge commit，PR 只能用 squash 或 rebase | 要开（见第 3 节） |
| Require a pull request | 要求通过 PR 更新目标分支；可另设审批人数、code owner、dismiss stale approvals、要求解决评论 | 当前暂不开；改为统一走 PR 时再评估 |
| Require status checks | 同一目标 SHA 在更新受保护分支前须已有检查结果；**strict** 还要求与最新 base 同步，另有 **loose** 模式 | 当前暂不开；先建立 PR 或同一 SHA 的预先检查流程 |
| Restrict creations / updates（tag 规则） | 只有具备对应 ruleset bypass 的身份能执行受限动作 | 创建权限与禁止更新/删除拆为两个 ruleset，避免创建 bypass 同时放开标签改写 |
| Require signed commits | 只接受签名且 verified 的提交 | **暂不开**，本地没配签名（见 `03-gap-analysis.md`） |
| Restrict commit metadata / branch names | 用正则约束 commit message、author、分支名；支持情况与试运行模式需按仓库计划核对 | 不启用强制 commit metadata，见 2.4 |

Branch protection 的管理员默认行为和 ruleset 的 bypass 配置不能混为一谈。Ruleset 按其 bypass list 决定哪些身份可以绕过，**owner 没有天然豁免**；bypass 覆盖整个 ruleset 内的规则（[官方说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)）。因此 `main` 基础保护不设置永久 admin bypass；发布标签的创建 ruleset 只给发布角色 bypass，禁止更新/删除的 ruleset 不设置 bypass。

Required status checks **不等于必须开 PR**：同一 SHA 先在其他分支通过检查，再直接推入受保护分支也可成立（[官方说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)）。本仓库当前 CI 自动触发于 push `main` 与 PR，另有手工触发，但尚无约定且验证过的「同一 SHA 预先检查 → 直推」流程，所以现在暂不开 required checks。若检查后生成了新 SHA，旧结果不能复用。

GitHub 只能识别账号、角色或 App，无法判断使用同一凭据的是人还是 AI；因此 ruleset 不能替代既有「推送授权」流程。

### 2.4 「Restrict commit metadata」的真实代价

[Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository) 有两条不显眼但会咬人的说明：

- `If you squash merge a branch, all commits on that branch must meet any metadata requirements for the base branch.` —— 也就是说，如果给 `main` 开了「commit message 必须符合 Conventional Commits」，**head 分支上每一个 WIP 提交也必须符合**，否则 squash 合并会被拒。想用这条规则，就得接受「分支上不允许 `wip:` `tmp:` 这种提交」。
- 正则里用 `\n?$` 而不是 `$`（`The optional \n? matches a trailing newline that may be present in Git push/CLI flows`）。

### 2.5 对本仓库意味着什么

| 结论 | 依据 |
|---|---|
| 用 **rulesets**，不用 branch protection / tag protection | 2.1、2.2 |
| `main` 当前目标：禁删除、禁强推、要求线性历史，bypass list 留空；required PR / checks 暂不开 | 2.3；当前保留有限直推路径且尚无同一 SHA 的预先检查流程 |
| `v*` 使用两个 ruleset：创建规则给发布角色 bypass；更新/删除规则不设 bypass | 2.3；bypass 不能按单条规则分配 |
| 「AI 不得推送」仍靠授权流程约束——ruleset 按身份授权，不能区分使用同一凭据的人与 AI | 2.3 末段 |
| 「强制 Conventional Commits」若开，会同时约束 WIP 提交；本仓库当前是「一个任务一串提交」的风格，需要先确认能否接受 | 2.4 |

---

## 3. 合并策略与提交规范

### 3.1 三种合并方式的代价

来自 [About merge methods on GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github)：

| 方式 | 历史形态 | 官方写明的代价 |
|---|---|---|
| Merge commit | 保留全部分支提交 + 一个 merge commit（`--no-ff`） | 历史分叉；不能与 linear history 规则共存 |
| Squash | 压成一个提交、fast-forward 进 base | 丢失「每个改动何时发生、谁做的」；同一对分支再次开 PR 时，已 squash 的提交会被重复列出，可能反复解冲突 |
| Rebase and merge | 逐提交重放到 base，无 merge commit | **重写后的提交不带签名验证**（`added to the base branch without commit signature verification`）；head 分支有冲突时要人 rebase 并 force push |

### 3.2 Squash 与「PR 标题即提交信息」

GitHub 的默认 squash 消息取决于提交数量：**1 个提交**时取提交标题与正文；**2 个及以上**时取 PR 标题与提交列表，合并时仍可编辑（[官方说明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests)）。因此仅校验 PR 标题，不足以保证单提交 PR 的最终标题合规。

本仓库目标配置是将默认 squash message 设为 **Pull request title**，并在合并时核对最终标题。完成该设置后，PR 标题才是各类 squash PR 的统一默认来源；分支 WIP 提交无需逐条改成 Conventional Commits。配置实际是否生效仍需在 GitHub 上核验。

### 3.3 Conventional Commits 1.0.0 的边界

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) 的结构是 `<type>[optional scope][!]: <description>` + 可选 body + 可选 footer。

- 语义映射：`fix` → PATCH、`feat` → MINOR、`BREAKING CHANGE`（footer 或 type 后的 `!`）→ MAJOR。
- 其它 type **合法但不影响版本**：`build` `chore` `ci` `docs` `style` `refactor` `perf` `test`。
- FAQ 里两句值得抄进规范：
  - 「在初始开发阶段也应像已经发布一样处理提交信息」——即 0.y.z 阶段不豁免；
  - 「用 squash 工作流时，主维护者可以在合并时清理提交信息」——这正是 PR 标题规范能代替逐提交规范的依据。
- 规范本身**不定义 revert**，只建议用 `revert` type + `Refs:` footer 引用被回滚的 SHA。

### 3.4 对本仓库意味着什么

| 结论 | 依据 |
|---|---|
| 合并方式选 **squash**：与「要求线性历史」一致，且 `main` 上现在本来就是线性、一句话式的提交（`feat: …` / `fix: …`） | 3.1、`git log --oneline` |
| 提交规范 = **PR 标题规范**，格式沿用现有风格：`<type>: <中文描述>`。`git log` 里已经在用 `feat` `fix` `docs` `chore` `test`，只是没写下来 | 3.2、3.3 |
| **不引入 commitlint / semantic-release / release-please**：本仓库 CHANGELOG 段落是「逐字进 GitHub Release 正文」的人工契约，自动生成会把 `--profile web` 安装段和既有段落格式冲掉 | 3.3 + `scripts/prepare-release.mjs` |
| rebase 合并**不用**：会丢签名验证（哪怕现在没开签名，也不该往那个方向走），且要求 force push | 3.1 |

---

## 4. 引用清单

| 主题 | 来源 |
|---|---|
| 分支生命周期 | <https://docs.github.com/en/get-started/using-github/github-flow> |
| 分支与受保护分支 | <https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-branches> |
| 集成/维护分支模型 | <https://git-scm.com/docs/gitworkflows> |
| rulesets 概览 | <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets> |
| rulesets 可用规则 | <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets> |
| rulesets 创建与 metadata 限制 | <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository> |
| tag protection 下线 | <https://github.blog/changelog/2024-05-29-sunset-notice-tag-protections/> |
| branch protection → rulesets 自动迁移 | <https://github.blog/changelog/2026-08-11-automatically-migrate-branch-protection-rules-to-repository-rulesets/> |
| 合并方式 | <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github> |
| Conventional Commits | <https://www.conventionalcommits.org/en/v1.0.0/> |
