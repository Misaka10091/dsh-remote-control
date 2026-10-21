# 02 · 版本语义与 Release 形态

> 外部实践 + 与现有流水线的冲突分析。第三节是本文件的核心：immutable releases 会让现在这条重试路径失效。

---

## 1. 版本语义

### 1.1 semver 里 0.y.z 到底意味着什么

[Semantic Versioning 2.0.0](https://semver.org/) 的原文：

- `Major version zero (0.y.z) is for initial development. Anything MAY change at any time. The public API SHOULD NOT be considered stable.`
- 官方起步建议：`start your initial development release at 0.1.0 and then increment the minor version for each subsequent release`
- `Version 1.0.0 defines the public API.`
- 已发布版本不可改：`Once a versioned package has been released, the contents of that version MUST NOT be modified.`

由此得到两条对本仓库直接生效的推论：

1. **停在 0.x 不是「不成熟」，是准确声明。** 本仓库 README 明写「阶段 6 真机验证未执行」，面板 API 与配对流程还在动，`1.0.0` 会给出一个目前不成立的承诺。
2. **0.x 阶段的不兼容改动用 MINOR 表达**（`0.1.x → 0.2.0`）。semver 没强制这么干——它说 0.y.z 可以随便变——但既然选了 `0.1.0` 起步，`0.2.0` 承载 breaking、`0.1.2` 承载修复，是唯一让版本号仍然有信息量的排法。**这条是本仓库的约定，不是 semver 的强制要求，规范里必须写明这一点。**

### 1.2 预发布与 build metadata

| 形式 | 合法性 | 优先级 | 本仓库处理 |
|---|---|---|---|
| `1.0.0-alpha` < `1.0.0-alpha.1` < `1.0.0-beta` < `1.0.0-rc.1` < `1.0.0` | ✅ | 数字段比字母段低；段数多者更高 | `v0.2.0-beta.1` → dist-tag `next` |
| `1.0.0+build` | ✅ semver 合法 | **不参与优先级** | **本仓库标签文法拒收**（`prepare-release.mjs` 的正则不收 build metadata） |
| `v1.2.3` | ❌ 不是 semver 版本 | — | 只是**标签名**，语义版本是 `1.2.3`（semver 官方 FAQ 明确这么说） |

最后一行是个容易被说错的点：`v` 前缀属于 git 标签约定，不属于 semver。所以「标签文法」和「版本号语法」是两个东西，本仓库用一条正则同时管住它们（`/^v(0|…)\.…/`），这是有意的简化，不是错误。

### 1.3 npm dist-tag 的硬规则

来自 [npm-dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag)：

- `Publishing a package sets the latest tag to the published version unless the --tag option is used.` —— 所以「设 dist-tag」是 publish 动作的一部分，不需要 `npm dist-tag add`；
- `Other than latest, no tag has any special significance to npm itself.` —— `next` 是社区约定，不是 npm 特殊对待；
- **`Tags that can be interpreted as valid semver ranges will be rejected.`** —— `v1.4` 不能当 dist-tag（会被解释成 `>=1.4.0 <1.5.0`）；`next`、`beta`、`canary` 都安全。

### 1.4 「该升哪个号」：本仓库的判定表

现有 spec 只定义了标签**文法**，没定义**语义**。草案要补的是这张表：

| 改动 | 版本位 | 理由 |
|---|---|---|
| 抬高 `engines.dsh` 下限、或不再支持旧宿主 | MINOR（1.0 后 MAJOR） | 旧宿主用户升级插件会直接不可用 = 不兼容 |
| 删除/重命名 `dsh.plugin.json` 里的配置项、改默认值导致旧行为变化 | MINOR（1.0 后 MAJOR） | 用户配置会失效或行为反转 |
| 改 `cordis.patch.yml` 的 bundle patch、改 `src/index.js` 导出入口 | MINOR（1.0 后 MAJOR） | 宿主加载契约变了 |
| 新增面板 Tab、新增 API 字段、新增可选配置（默认行为不变） | MINOR | 向后兼容的新能力 |
| 修 bug、改文案、安全修补（不动契约） | PATCH | 同上 |
| 只有 README / CHANGELOG / `.trellis/` 文档改动 | **不发版** | 没有对用户可见的产物变化 |
| 安全修复 | 按影响面定 PATCH/MINOR，但**优先发** | semver 的「最佳判断」条款允许为了用户利益打破排法 |

semver 支持最后一条：`If you have a huge audience that will be drastically impacted by changing the behavior back… it may be best to perform a major version release` —— 版本号是**传递意图**的工具，不是自动机。同理，弃用要先发一个 MINOR 声明，再在下个 MAJOR 删除（`issue a new minor release with the deprecation in place`）。

---

## 2. GitHub Release 的形态

### 2.1 draft / published / Latest

来自 [Managing releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)：

- 不勾 `Set as latest release` 时，GitHub 按其自动规则选择 Latest；`gh release create --latest=false` 则显式声明本次发布不作为 Latest。本仓库对预发布保留 `--prerelease --latest=false`，分别表达候选版本性质和通道策略，不将「未设置 latest 参数」等同于「预发布会自动成为 Latest」。
- 不传 `--draft` 表示命令最终会尝试发布 Release，不代表它从创建瞬间就是公开状态：带资产的 `gh release create` 内部会先建 draft、上传资产，最后发布（[gh 手册](https://cli.github.com/manual/gh_release_create)）。中断可能留下 draft，因此重试必须检查状态。

### 2.2 Immutable releases：本仓库必须先解决的一个冲突

[Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) 开启后的真实规则：

- 标签**锁死**：`its associated Git tag is locked to a specific commit, cannot be changed, and cannot be deleted while the release exists`；
- 资产**不可改不可删**：`All files attached to the release … are protected from modification or deletion`；
- 仍可改的只有标题、正文、prerelease 标记、Latest 标记；
- 会**自动生成 release attestation**（tag + commit SHA + 资产的可加密验证记录）；
- **删除的代价**：`If you delete the immutable release, you can delete the tag, but you cannot reuse the same tag name.` —— 也就是说「删掉 Release、删掉 tag、重新推同一个 tag」这条路**永久失效**；
- 开关位置：仓库 Settings → 滚动到 "Releases" 段 → `Enable release immutability`；组织级可在 Settings → Repository → General → Releases 设策略。**只对开启之后的发布生效**（`immutability will only apply to future releases`）。

现在这条与 `.github/workflows/npm-publish.yml` 第 104–105 行直接冲撞：

```bash
if gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
  gh release upload "$RELEASE_TAG" "$TARBALL" --clobber   # ← immutable 之后必然失败
```

开启 immutability 后，`--clobber` 会报错，而「删 Release 重来」又会永久烧掉那个 tag 名。

**订正（初稿结论有误）**：初稿写「必须改成 draft-first」。这一点是多余的——[gh 的手册](https://cli.github.com/manual/gh_release_create)明确说，带资产创建时它内部**本来就是**三步：

> When using the `create` command to attach assets to a release, separate API calls are made to create the release as a draft, upload the assets, and then publish the release. Immutability protections will be enforced ONLY after the release is published.

所以真正要改的不是创建路径，而是**重试时对状态的判断**。现在的脚本只区分「存在 / 不存在」，开启 immutable 后必须区分三种，因为 draft 也满足 `gh release view`：

| 状态 | 判据 | 行为 |
|---|---|---|
| 不存在 | `gh release view` 失败 | `gh release create`（内部 draft → 传 → publish） |
| 存在但仍是 draft（上次中断） | `--json isDraft` = `true` | draft 可变：`--clobber` 补传资产，**然后 `gh release edit --draft=false`** |
| 已发布 | `--json isDraft` = `false` | **只校验不写**：比对资产与 `npm view … dist.integrity`，不一致就中止交人 |

第二种是最隐蔽的失败模式：上传中断留下 draft，重跑走进「已存在」分支，`--clobber` 成功，但**后面没有 publish**，Release 永远停在 draft。

`gh release view --json` 没有 `isLatest` 字段（可用字段见 [手册](https://cli.github.com/manual/gh_release_view)），Latest 只能从 `GET /repos/{owner}/{repo}/releases/latest` 读。

### 2.3 provenance 与 attestation 不是一回事

| 名称 | 谁生成 | 证明什么 | 本仓库现状 |
|---|---|---|---|
| **npm provenance** | npm registry，在 Trusted Publisher（OIDC）发布时自动生成 | 「这个 tarball 是由 repo X 的 workflow Y 从 commit Z 构建并发布的」 | 已在用（`docs/RELEASING.md` 明确说明） |
| **release attestation** | GitHub，在 immutable release 发布时生成 | 「这个 Release 的 tag、commit SHA、资产自发布起未被改动」 | **未核验**；需核对仓库 immutable 设置和具体 Release，不能从 `--clobber` 代码推断开关状态 |

两者互补但不重叠：provenance 绑定「构建来源」，attestation 绑定「发布后未被篡改」。规范里不能把其中一个说成另一个的证据。

### 2.4 对本仓库意味着什么

| 结论 | 依据 |
|---|---|
| 0.x 的 bump 规则要写进 spec，但必须标注「本仓库约定，非 semver 强制」 | 1.1 |
| `engines.dsh` 抬高下限 = MINOR，不是 PATCH | 1.4 |
| 现在**不要**开 immutable releases，除非先把重试逻辑改成「三状态」并在同一 tag 上演练过 | 2.2 |
| 若开启，Retry 语义要重写：不再是「重传同一资产」，而是「校验已发布资产完整性与 npm integrity 一致，然后什么都不做」 | 2.2 |
| `--latest=false` 必须保留在 prerelease 分支上 | 2.1 |

---

## 3. 引用清单

| 主题 | 来源 |
|---|---|
| semver 全文（0.y.z、预发布优先级、`v` 前缀） | <https://semver.org/> |
| npm dist-tag | <https://docs.npmjs.com/cli/v11/commands/npm-dist-tag> |
| Release 管理（Latest 自动判定、draft） | <https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository> |
| Immutable releases 概念 | <https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases> |
| 开启 immutable releases 的开关位置 | <https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/preventing-changes-to-your-releases> |
| npm Trusted Publisher / provenance | <https://docs.npmjs.com/trusted-publishers/> |
