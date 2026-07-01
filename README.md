# Context Snapshot Plugin

> **版本**：v0.6.0
> **状态**：核心功能实测通过（CLI 3.0.30+），受 §1.15 codec bug 部分阻塞
> **上游决策**：[ADR-005](../docs/decisions/ADR-005-split-compact-from-handoff.md)（Accepted，Compaction 与 Handoff 拆分）

在 Cline 上下文压缩（compact）事件触发时自动生成结构化的 **context snapshot**（窗口内会话摘要），并通过 `rules` 注入在新会话中恢复上下文。

> **术语约定（ADR-005）**：
> - **context snapshot**（本插件产物）= 窗口内压缩产物，自动生成，用于 compact 后恢复
> - **handoff**（`docs/handoff.md`）= 跨会话状态快照，用户手写，用于跨 Agent 状态交接
>
> 两者是独立机制，本插件只负责 context snapshot。

---

## 故事线

Cline 会话中 **73% 的任务是 resumed 会话**——跨会话续作是主流场景。手工写 handoff 已被验证有效，但纯靠记忆与手动操作，不可持续。

**Context Snapshot Plugin** 将会话内压缩的上下文恢复机制化为代码：compact 触发时自动提取决策、文件改动、未完成项，写出结构化 snapshot；新会话启动时通过 `rules` 动态注入最新 snapshot。

### 版本演进

| 版本 | 状态 | 说明 |
|------|------|------|
| v0.5.0 | ✅ 完成 | Plugin 骨架加载 + compact 检测 + token 估算修复 |
| v0.6.0 | ✅ 完成 | ADR-005 命名落地 + snapshot-writer 实现 + Loop Guard + 契约修复 |
| v0.7.0 | ⏳ 规划中 | 结构化提取器（DecisionExtractor / TodoExtractor 等）|

---

## 架构

```
Cline Agent Turn
    ↓
@cline/agents turn-preparation
    ↓
  messageBuilder.build(messages)  ← 本 Plugin 在此介入
    ├─ shouldCompact() 判定 token 阈值（75% of 120K）
    ├─ 需要 compact → writeSnapshot() 写入 context snapshot
    └─ 返回 messages（本 Plugin 不修改消息内容）
    ↓
@cline/core API-safety message builder（最终保护）
    ↓
  hooks.beforeModel               ← #4 Loop Guard 在此注入
    ↓
provider 调用
```

### 四类能力

| 模块 | Cline 能力 | 职责 | 对应候选 |
|------|-----------|------|---------|
| `compact-observer` | messageBuilders | 观察 compact 事件，写入 context snapshot | #5 |
| `rules-injector` | rules | 动态读取最新 snapshot 注入新会话 | #6 |
| `tool-recorder` + `beforeModel` | hooks | 工具调用记录 + Loop Guard 检测/注入 | #1 + #4 |

### Snapshot 产物

| 产物 | 路径 | 格式 | 用途 |
|------|------|------|------|
| context snapshot | `~/.cline/data/snapshot/<project_hash>-<timestamp>-<uuid>.md` | Markdown（5 节模板）| compact 后恢复上下文 |

> **注**：ADR-005 已废弃 `index.jsonl`。Cline SQLite DB 已存储会话元数据，自建索引职责重叠。待 Cline 暴露稳定查询接口后再考虑接入。

### Snapshot 5 节模板

```
# Context Snapshot — <会话标题>
## 本会话决策          (表格)
## 本会话净变化         (文件改动 / 工具使用)
## 未完成项 / 后续动作   (表格)
## 权威源              (引用的文档/源码)
```

当前提取基于简单正则（v0.6.0），精度有限。v0.7.0 规划结构化提取器以提升精度。

---

## 安装

### 前置条件

- Cline CLI 3.0.30+（**唯一可用的 Plugin 运行环境**）
- Node.js 22+

> **⚠️ VS Code 扩展 4.0.x 不支持 Plugin 系统**
>
> Cline VS Code 扩展 4.0.1 已回滚到 pre-SDK 代码基（3.89.2），Plugin 系统不存在。
> 详见 [dev-rules.md §1.15](../docs/dev-rules.md) 不可抗力声明。

### 安装到全局 plugin store

```bash
cline plugin install <plugin-url>
```

安装后 `setup()` 会在 `~/.cline/data/snapshot/` 写入 `plugin-loaded.marker` 确认加载。

---

## 验证

### 1. Plugin 加载标记

```bash
type %USERPROFILE%\.cline\data\snapshot\plugin-loaded.marker
```

### 2. Snapshot 写入验证（workaround 路径）

由于 §1.15 codec bug 阻塞真实 90K+ token 长对话路径，可通过临时降低阈值验证：

1. 临时将 `compaction.ts` 中 `MAX_INPUT_TOKENS` 改为 `1000`
2. 进行短对话触发 compact
3. 检查 `~/.cline/data/snapshot/` 下是否产出 `.md` 文件
4. 验证后改回 `120000`

```bash
dir %USERPROFILE%\.cline\data\snapshot\*.md
```

### 3. Rules 注入验证

在新会话中注入含标记的 snapshot，确认 Cline 能正确答出 snapshot 内容。

### 4. Loop Guard 检测验证

交替使用不同工具（避免模型优化重复读取），观察 `loop-guard-instrument.log` 中 `detectRepetition` 输出。

> **注**：Loop Guard 注入层（beforeModel 返回 messages 修改）受 §1.15 codec bug 阻塞，检测层已 Verified。

---

## 源码结构

```
handoff-plugin/
├── package.json             ← manifest（name: context-snapshot）
├── tsconfig.json
└── src/
    ├── index.ts             ← plugin 入口 + setup() 注册三类能力 + hooks
    ├── constants.ts         ← PLUGIN_NAME + getSnapshotDir()
    ├── compaction.ts        ← token 估算 + shouldCompact 判定
    ├── snapshot-writer.ts   ← 5 节模板生成 + 磁盘写入
    ├── rules-injector.ts    ← context snapshot 动态注入
    ├── tool-recorder.ts     ← 工具调用记录 + detectRepetition
    └── types.ts             ← 类型定义
```

> **目录名说明**：`handoff-plugin/` 是历史目录名，源码内部已全部重命名为 context-snapshot 术语（ADR-005 落地）。目录重命名待后续处理。

---

## 设计文档

- [docs/plugin/design.md](../docs/plugin/design.md) — 9 章设计文档（架构、触发条件、降级行为、Risk）
- [docs/plugin/plugin-dev-sop.md](../docs/plugin/plugin-dev-sop.md) — Plugin 开发规划框架

## 上游决策

- [ADR-001](../docs/decisions/ADR-001-handoff-compact-memory.md) — 方向决策（Accepted，A+B'+D'）
- [ADR-005](../docs/decisions/ADR-005-split-compact-from-handoff.md) — Compaction 与 Handoff 拆分（Accepted）
- [custom-compaction.ts](https://github.com/cline/cline/blob/main/sdk/examples/plugins/custom-compaction.ts) — 设计母本

## 已知限制

| 限制 | 状态 | 详见 |
|------|------|------|
| VS Code 扩展 4.0.x 不支持 Plugin | 不可抗力 | [dev-rules.md §1.15](../docs/dev-rules.md) |
| CLI codec bug（`n.content.map is not a function`）| 🔴 阻塞真实长对话路径 | [investigation-note-cli-codec-content-map-bug.md](../docs/decisions/investigation-note-cli-codec-content-map-bug.md) |
| Snapshot 提取基于简单正则 | 🟢 v0.7.0 规划结构化提取器 | — |
| 双重 setup() 调用 | 🟡 Cline hub 模式架构（Likely）| [investigation-note-dual-setup.md](../docs/decisions/investigation-note-dual-setup.md) |
