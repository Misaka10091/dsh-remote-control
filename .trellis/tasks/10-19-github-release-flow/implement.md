# 实施：GitHub 发布流

> 顺序：先写可单测的校验脚本（本地就能验），再写工作流，最后重写文档。

## 0. 准备

- [ ] 读参考实现：`D:\workspace\github\dsh-git-panel\.github\workflows\{ci,npm-publish}.yml`、`scripts/prepare-release.mjs`、`tests/release.test.mjs`
- [ ] 基线：`npm test`、`npm run check:syntax`、`npm pack --dry-run`（记下文件数，当前 31）
- [ ] 确认本仓库 `CHANGELOG.md` 段落格式为 `## vX.Y.Z — YYYY-MM-DD`

## 1. 发布校验脚本（先做，本地可验）

- [ ] 新增 `scripts/prepare-release.mjs`：导出 `prepareRelease()`，并支持 CLI `<tag> <output-dir>`
- [ ] 六条校验：标签文法 / 预发布无前导零 / 包名 / `package.json` 版本 / `dsh.plugin.json` 版本 / `repository.url` / CHANGELOG 段落非空
- [ ] 产出 `notes.md` + `metadata.json`；有 `GITHUB_OUTPUT` 时追加 `package`/`version`/`dist_tag`/`prerelease`
- [ ] 安装小节用 `dsh plugin --profile web add <pkg>@<version>`
- [ ] 新增 `tests/release.test.mjs`：稳定版→`latest`、预发布→`next`+prerelease、非法标签与三方不一致各自终止、包名/仓库不符终止、CHANGELOG 缺失或为空终止
- [ ] `node --test tests/release.test.mjs` 绿
- [ ] 真跑一次：`node scripts/prepare-release.mjs v0.1.0 "$env:TEMP/rel"`，检查产物

## 2. package.json

- [ ] `scripts.version`：同步 `dsh.plugin.json` 的 version 到 `package.json`（与参考一致，含 `git add`）
- [ ] `check:syntax` 追加 `node --check scripts/prepare-release.mjs`
- [ ] 不动 `files` 白名单（`scripts/`、`.github/` 不进包）

## 3. 工作流

- [ ] `.github/workflows/ci.yml`：`push: main` / `pull_request` / `workflow_dispatch`；Node 24；三步：`check:syntax`、`npm test`、`npm pack --dry-run`
- [ ] `.github/workflows/npm-publish.yml`：
  - [ ] 触发：`push.tags: v[0-9]*.[0-9]*.[0-9]*` + `workflow_dispatch.inputs.tag`
  - [ ] 权限：顶层 `contents: read`；job 级 `id-token: write` + `contents: write`
  - [ ] `concurrency: npm-release-<tag>`，`cancel-in-progress: false`
  - [ ] `checkout` 固定读标签、`fetch-depth: 0`；`npm i -g npm@11`
  - [ ] 步骤顺序：prepare-release → check:syntax → test → pack --dry-run → pack 一次 → 幂等发布 → Release
  - [ ] 不出现 `NPM_TOKEN` / `secrets.*`
- [ ] 本地核对：YAML 能被解析（`node -e` 读文件或用 Python `yaml.safe_load`），触发条件与权限与 PRD 一致

## 4. 文档

- [ ] 重写 `docs/RELEASING.md`，保留并整合原有内容：
  - [ ] 开头写清「0.1.0 首发必须手工（npm 上还没有这个包）」与顺序图
  - [ ] 一次性配置 Trusted Publisher 字段表（Organization/Repository/Workflow filename/Environment/Allow npm publish）
  - [ ] 日常发版：`npm version X.Y.Z --no-git-tag-version` → 写 CHANGELOG → 跑三件事 → `git tag -a` → `git push --atomic`
  - [ ] 失败与重跑（含 integrity 相同/不同的两种分支）
  - [ ] 验证边界：本地能验什么、OIDC 发布只能真跑（验收 8）
  - [ ] 保留原有的「发布不得声称的内容」（真机验证那段）
- [ ] `README.md`：如有「发布」段落，指向 `docs/RELEASING.md`

## 5. 收尾

- [ ] `npm test` 全绿（含新测试）
- [ ] `npm run check:syntax`
- [ ] `npm pack --dry-run`：文件数仍是 31，且**不含** `scripts/`、`.github/`
- [ ] `CHANGELOG.md` 增补本次改动（Added/Changed）
- [ ] 更新 `.trellis/spec/`：把「发布前校验前置到可单测脚本」这条记进 backend 规范

## 验证命令

```bash
node --test tests/release.test.mjs
node scripts/prepare-release.mjs v0.1.0 "$env:TEMP/rel"
npm test
npm run check:syntax
npm pack --dry-run
```

## 回滚点

- 第 1 步只新增文件；删掉即回到现状。
- 第 3 步只新增 `.github/`，不影响本地流程；`package.json` 的两处改动是唯一对既有文件的修改（可单独回滚）。
