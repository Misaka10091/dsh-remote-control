# GitHub 发布流：CI、OIDC 发布与 Release 自动化

## 背景

本仓库目前**没有 `.github/`**：没有 CI，`docs/RELEASING.md` 描述的是一条纯手工流程（本地跑三件事 → `git tag` → `git push` → `npm publish`）。
手工流程有三个已经看得见的风险：

1. 没有 CI，任何 push/PR 都不会自动跑 `npm test`——本仓库的测试强度（550+ 条）只有在本地手动跑时才存在。
2. 发布没有前置校验：标签与 `package.json` / `dsh.plugin.json` 版本不一致、`CHANGELOG.md` 缺该版本段落、仓库地址不对（npm provenance 需要它）都能一路推到 `npm publish` 才炸。
3. 发布内容与 GitHub Release 是两件手工事，容易不一致（Release 附件不是 npm 上那个包）。

参考实现 `dsh-git-panel` 已经把这套跑通并迭代出细节：`.github/workflows/ci.yml`、
`.github/workflows/npm-publish.yml`（标签触发、OIDC 发布、幂等重跑）、`scripts/prepare-release.mjs`（可单测的发布校验）、
`tests/release.test.mjs`、以及一份写得很细的 `docs/RELEASING.md`。

**一个必须先讲清的前提**：`@misaka10091/dsh-remote-control` 在 npm 上**尚不存在**（2026-10-19 实测 `npm view` 返回 E404）。
npm Trusted Publisher 只能在**已存在的包**的 Settings 里配置，因此首发那一次必然是手工的；工作流从第二个版本起接管。
文档必须把这个顺序写在最前面，否则照着参考实现的文档走会卡在「包不存在 → 配不了 Trusted Publisher」。

## 目标

1. 每次 push 到 `main` 与每个 PR 都自动跑「语法检查 + 全量测试 + 打包清单校验」。
2. 推 `vX.Y.Z` 标签即自动发布 npm 包并创建 GitHub Release，附件与 npm 上是**同一个 `.tgz`**。
3. 发布前把三类错误挡在 `npm publish` 之前：标签文法、标签↔两个清单的版本一致性、`CHANGELOG.md` 缺该版本段落。
4. 发布凭据只用 GitHub OIDC（Trusted Publisher），**不引入任何仓库 Secret**。
5. 失败可安全重跑：npm 上已有同 integrity 的包就跳过上传继续建 Release；内容不同则终止并提示升版本。
6. 文档写清「哪些能本地验证、哪些只能真跑」——不把「本地干跑通过」说成「发布链路已验证」。

## 范围

| # | 能力 | 说明 |
|---|---|---|
| R1 | CI 工作流 | `.github/workflows/ci.yml`：`push: main` / `pull_request` / 手动触发，跑 `check:syntax` → `npm test` → `npm pack --dry-run` |
| R2 | 发布工作流 | `.github/workflows/npm-publish.yml`：`push` 标签 `v[0-9]*.[0-9]*.[0-9]*` 或手动输入既有标签触发；标签校验 → 检查 → 打包一次 → npm 发布 → GitHub Release |
| R3 | 发布校验脚本 | `scripts/prepare-release.mjs`：纯函数 `prepareRelease()` + CLI；校验标签文法、三方版本一致、`repository.url`、CHANGELOG 段落非空；产出 Release 正文与 `dist_tag`/`prerelease` |
| R4 | 脚本单测 | `tests/release.test.mjs`：稳定版→`latest`、预发布→`next` 且标 prerelease、非法标签/版本不一致/包名与仓库不符/CHANGELOG 缺失或为空各自终止 |
| R5 | 幂等与重跑 | npm 已有该版本：integrity 相同则跳过发布继续建 Release；不同则终止（npm 不允许覆盖）；Release 已存在则补传同一附件 |
| R6 | 发布文档 | 重写 `docs/RELEASING.md`：首发手工步骤（含 2FA）→ 配置 Trusted Publisher（字段表）→ 日常发版 → 失败与重跑 → 验证边界 |

### 明确不在范围内

- **不使用 `NPM_TOKEN` 或任何仓库 Secret**（用户已定：只走 OIDC）。
- 不做 staged publishing 的自动批准流程（若 npm 侧启用暂存，由维护者手工 Approve）。
- 不做多平台构建/交叉编译（纯 JS 包，无构建产物）。
- 不改包名、scope、`files` 白名单或 profile 安装方式。
- 不引入 release-please / semantic-release 之类的外部发布工具。
- 不自动递增版本：版本号由人决定（`npm version --no-git-tag-version`）。

## 验收标准

1. `.github/workflows/ci.yml` 在 `push: main`、`pull_request`、`workflow_dispatch` 上触发，跑且只跑三件事（语法、测试、打包清单），不依赖任何 Secret。
2. `.github/workflows/npm-publish.yml` 由 `v[0-9]*.[0-9]*.[0-9]*` 标签或手动输入既有标签触发；默认 `permissions: contents: read`，job 级只加 `id-token: write`（OIDC）与 `contents: write`（建 Release）；`checkout` 始终读取**标签指向的提交**而不是所选分支。
3. `scripts/prepare-release.mjs` 可被 `import` 也可当 CLI 跑；`node scripts/prepare-release.mjs v0.1.0 <tmpdir>` 在本仓库**真实执行成功**，产出 `notes.md` 与 `metadata.json`，并在设置了 `GITHUB_OUTPUT` 时追加 `package`/`version`/`dist_tag`/`prerelease` 四行。
4. 以下四种输入必须让脚本**非零退出**：非法标签（`main`、`v01.1.0`、`v0.1`、`v0.1.0-beta.01`、`v0.1.0+build`）、标签与 `package.json` 版本不一致、标签与 `dsh.plugin.json` 版本不一致、包名或 `repository.url` 不符、`CHANGELOG.md` 缺该标签段落或段落为空。
5. 稳定版发布到 npm `latest` 且 Release 不带 prerelease 标记；`v0.2.0-beta.1` 之类发布到 `next`、Release 标 prerelease 且不更新 GitHub Latest。
6. Release 正文 = `CHANGELOG.md` 中该标签段落 + 安装命令；**不混入**其它版本的段落。
7. `npm test` 全绿（含新增 `tests/release.test.mjs`）；`npm run check:syntax` 覆盖新脚本；`npm pack --dry-run` 的文件清单**不含** `scripts/` 与 `.github/`（`files` 白名单不变，仍是 31 个文件）。
8. 文档如实写明验证边界：本地能验证的是「脚本校验逻辑 + 工作流 YAML 语法 + 干跑打包」；**OIDC 真实发布与 GitHub Release 只能由一次真实运行验证**，未跑之前不得声称已验证。

## 关键约束

1. 零运行时依赖不变；新增的 `scripts/` 与 `.github/` 只进 git，不进 npm 包。
2. CI 环境与参考实现一致：GitHub 托管 `ubuntu-latest`、Node 24、npm 11（Trusted Publisher 要求 npm ≥ 11.5.1、Node ≥ 22.14.0）。
3. 发布工作流不得读取 `NPM_TOKEN`；凭据来自 OIDC，`id-token: write` 是唯一授权来源。
4. 首发手工发布与工作流发布**不得重复发布同一版本**；文档要写明这一点。
5. 本仓库的 `CHANGELOG.md` 段落格式是 `## vX.Y.Z — YYYY-MM-DD`（与参考实现一致），`prepare-release.mjs` 依赖该格式。

## 已定稿的决策

| # | 问题 | 决策 |
|---|---|---|
| D1 | 触发方式 | 推 `vX.Y.Z` 标签触发（与参考实现一致），另留 `workflow_dispatch` 输入既有标签用于重跑 |
| D2 | 发布凭据 | 只用 GitHub OIDC / Trusted Publisher，不加 `NPM_TOKEN` |
| D3 | 首发处理 | 0.1.0 手工发布（npm 上尚无该包），随后在 npm Settings 配 Trusted Publisher，工作流从下一个版本起生效 |
| D4 | 校验位置 | 全部前置到 `scripts/prepare-release.mjs`（可单测、可在本地干跑），工作流只做编排 |
