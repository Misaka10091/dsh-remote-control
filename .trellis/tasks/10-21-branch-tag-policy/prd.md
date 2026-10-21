# 调研 GitHub 分支与标签最佳实践并起草规范

## Goal

把 GitHub 侧「分支 / 标签 / 合并 / 版本语义 / Release 形态」的做法调研清楚，对照本仓库现状找出差距，产出：

1. 一份带来源的调研报告（外部实践 + 本仓库事实）；
2. 一份可直接落地到 `.trellis/spec/release/` 的规范草案。

**本阶段不改 `.trellis/spec/`、不改 `.github/`、不改任何代码。** 草案审过之后再单独开任务落地。

## Requirements

### R1 调研范围（用户已圈定，不做取舍）

| # | 主题 | 必须回答的问题 |
|---|---|---|
| R1.1 | 分支模型与命名 | 单 maintainer + tag 触发发布的仓库该用 GitHub Flow 还是 trunk-based？什么时候才真的需要 `release/x.y` 维护分支？分支名怎么起、什么时候删？ |
| R1.2 | 保护规则与 Rulesets | `main` 上该开哪些规则？`v*` 标签怎么保护？branch protection 与 rulesets 的取舍？tag protection 现在还能用吗？ |
| R1.3 | 合并策略与提交规范 | squash / rebase / merge commit 选哪个，代价是什么？Conventional Commits 要不要强制、怎么强制？PR 标题与提交信息的关系？ |
| R1.4 | 版本语义 | 0.y.z 阶段怎么 bump？`engines.dsh` 下限抬高算不算 breaking？`next` 预发布通道怎么和标签对应？ |
| R1.5 | Release 形态 | draft / immutable release / Latest 语义 / provenance 与 attestation 分别是什么，和现有流水线冲不冲突？ |

### R2 必须以本仓库事实为准，不写通用模板

每条结论要么落到本仓库的具体文件/命令/行为上，要么明确标注「与本仓库无关，不建议引入」。禁止把「业界一般这么做」当成「本仓库该这么做」。

### R3 必须区分「可本地验证」与「只能上线验证」

本仓库的 `release/tag-and-release.md` 已有一张「本地能证明什么不能证明什么」的表，草案必须继承这个诚实度：GitHub 侧设置（rulesets、immutable releases）本地无法验证，必须写成「待人工确认」并给出核对命令，不能写成「已启用」。

### R4 明确不做的范围

- 不引入 changelog 自动生成（release-please / semantic-release / changesets）；
- 不引入 merge queue（单 maintainer，无排队需求）；
- 不引入 signing（本地无 GPG/SSH 签名配置，开了会直接卡住提交）；
- 不改现有 tag 文法正则、不改 `prepare-release.mjs` 的校验契约。

理由写在 `research/03-gap-analysis.md` 的「不采纳项」一节。

## Deliverables

| 文件 | 内容 |
|---|---|
| `research/01-github-practices.md` | 分支模型 / 保护规则 / 合并与提交的外部实践，逐条带官方来源 |
| `research/02-versioning-and-release-shape.md` | 版本语义与 Release 形态的外部实践，含 immutable releases 与现有 `--clobber` 的冲突分析 |
| `research/03-gap-analysis.md` | 现状 vs 实践逐项差距表 + 采纳/不采纳决策 + 待人工确认清单 |
| `spec-draft-git-and-tag-policy.md` | 可直接落地为 `.trellis/spec/release/` 内容的规范草案（含 Wrong vs Correct 与验证命令） |

## Acceptance Criteria

- [ ] 五个主题（R1.1–R1.5）每个都有结论，且结论能指到本仓库的具体文件/命令；
- [ ] 调研报告里每条外部实践都有官方文档链接，不引用二手博客当依据；
- [ ] 每条建议标注「现状 / 差距 / 是否采纳 / 代价」，不采纳的要写理由；
- [ ] 草案里的 GitHub 侧设置逐条标注「本地不可验证」，并给出人工核对命令；
- [ ] 草案与既有 `release/tag-and-release.md` 不冲突；若有冲突（如 `gh release upload --clobber` 与 immutable releases），必须显式指出并给替代路径；
- [ ] 本阶段工作区只有 `.trellis/tasks/10-21-branch-tag-policy/` 下的新增文件，`.trellis/spec/`、`.github/`、`src/` 均未改动。

## Notes

- 用户选择的交付形态是「建任务，但先只出调研报告 + spec 草案」，所以本任务 `status` 保持 `planning`，不进入 `in_progress` 实现阶段。
- 落地任务（改 spec、改 workflow、开 ruleset）应当另开任务，并以本文档的验收结论为输入。
