# Release Guidelines

> 本目录规范「这个包怎么产生一个版本」：版本号、标签、CHANGELOG、npm 发布、GitHub Release。

---

## Overview

`@misaka10091/dsh-remote-control` 是**单包双清单、无构建步骤、零运行时依赖**的 DSH 插件。发布链路的三个事实决定了本目录的全部规则：

1. **发布由 git tag 触发**，不靠本地 `npm publish`（`0.1.0` 的历史例外见下）。推一个 `vX.Y.Z` 标签，`.github/workflows/npm-publish.yml` 通过 GitHub OIDC（npm Trusted Publisher）发布并创建带同一个 `.tgz` 的 GitHub Release。
2. **仓库里没有任何 `NPM_TOKEN`，也不该有。** job 级权限 `id-token: write` 是唯一凭据来源，`contents: write` 只用于创建 Release。
3. **发布的判定入口是一个可单测的纯函数**：`scripts/prepare-release.mjs`。workflow 只做编排，判断全部在这个脚本里——因为 workflow YAML 无法单测，写在里面的检查没人能证明它有效（`tests/release.test.mjs` 开头注释即是此理由）。

给人读的操作手册是 `docs/RELEASING.md`；本目录是给改代码的 agent 读的硬约束，两者冲突时以代码与本文档为准并同步修正 `docs/RELEASING.md`。

**文档语言：中文**；代码标识符、命令、日志原文保持英文。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Tag & Release](./tag-and-release.md) | 标签文法、三方版本一致、CHANGELOG 契约、dist-tag、流水线顺序、幂等重试、打包边界、验证边界 | Done |

---

## Pre-Release Checklist

发版前逐条打勾，全部来自本仓库真实存在的关卡：

- [ ] `package.json#version` 与 `dsh.plugin.json#version` 相等（`tests/package.test.mjs` 的 "the two manifests agree on the version"）
- [ ] `engines.dsh` 与**实测**宿主版本一致：先跑 `dsh --version`，不要从别的包推断（曾因此判错一次）
- [ ] `CHANGELOG.md` 里 `## vX.Y.Z — YYYY-MM-DD` 段落**已存在且非空**；顺序是先写段落再打标签
- [ ] 本次新增的每个源文件都已进入 `package.json#files`（`files` 是发布边界，漏一个 = 装上后加载即失败）
- [ ] 新增模块已加进 `npm run check:syntax` 的显式清单（`tests/package.test.mjs` 会红）
- [ ] 三条 gate 全绿：`npm test` / `npm run check:syntax` / `npm pack --dry-run`
- [ ] `node scripts/prepare-release.mjs vX.Y.Z <临时目录>` 本地干跑通过，`notes.md` 里的安装命令是 `dsh plugin --profile web add …`
- [ ] 标签用 annotated（`git tag -a vX.Y.Z -m "Release vX.Y.Z"`），推送用 `git push --atomic origin main vX.Y.Z`
- [ ] 文档里没有把「自动化已验证」写成事实（第 4 层从未真跑过，见 [Tag & Release](./tag-and-release.md#本地能证明什么不能证明什么)）

## Quality Check

```bash
npm test                # 整套 node:test，含 tests/release.test.mjs 与 tests/package.test.mjs
npm run check:syntax    # 每个宿主模块 + scripts/prepare-release.mjs
npm pack --dry-run      # 产物清单：应为 33 个文件，且不含 scripts/、.github/
```

发布前的额外干跑（不碰 npm、不碰 git、不联网）：

```bash
node scripts/prepare-release.mjs vX.Y.Z .release-dry-run   # 产出 notes.md + metadata.json
```

人工过一遍 [Tag & Release 的「常见错误」](./tag-and-release.md#常见错误)。

---

## 关键事实（不在别处重复）

- **`0.1.0` 是手工发布的**：包当时还不在 npm 上，而 npm Trusted Publisher 只能配置在**已存在**的包上，所以自动化无法完成首发。从下一个版本起才是 tag → OIDC 发布（`docs/RELEASING.md` 第一节）。
- **包内共 33 个文件**（实测计数，不是断言）。`scripts/`、`.github/`、`docs/`、`tests/` 故意不进包。该数字没有任何测试守着，改动后要重新数，不要引用旧数字。
- **`npm version` 的 lifecycle 脚本会同步两个清单**：`scripts.version` 把 `package.json#version` 写进 `dsh.plugin.json` 并 `git add`，所以用一条命令即可保持一致。
- **标签文法、三方版本、`repository.url`、CHANGELOG 段落**这四类错误都在 `npm publish` 之前被拒；一旦 publish 成功，版本就不可回滚（npm 不允许覆盖已发布版本）。
- **本地最多验到第 3 层**（脚本规则、真实清单干跑、workflow 可解析）。第 4 层「真实 OIDC 发布 + GitHub Release」只能靠一次真实 tag 推送，尚未发生。
