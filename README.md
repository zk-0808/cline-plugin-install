# Auto Handoff Plugin

在 Cline 上下文压缩（compact）事件触发时自动生成结构化手写交接文档（handoff.md）与可搜索索引（index.jsonl）。

## 故事线

Cline 会话中 **73% 的任务是 resumed 会话**——跨会话续作是主流场景。手工写 handoff 已被验证有效，但纯靠记忆与手动操作，不可持续。

**Auto Handoff Plugin** 将这一经验机制化为代码：
- Phase 1（✅ 完成）：Plugin 骨架加载验证，确认 `registerMessageBuilder` 在 VS Code 扩展 4.0.0 中可正常工作
- Phase 2（✅ 完成）：compact 触发时自动提取会话决策、文件改动、未完成项，写出 handoff.md + index.jsonl
- Phase 3（⏳ 待实现）：index.jsonl 字段补齐（summary + key_terms + decision_count）
- Phase 4（⏳ 待实现）：VS Code 扩展端全链路闭环验证

## 架构

```
Cline Agent Turn
    ↓
@cline/agents turn-preparation
    ↓
  run lifecycle hooks
    ↓
  messageBuilder.build(messages)  ← 本 Plugin 在此介入
    ├─ shouldCompact() 判定 token 阈值（75% of 120K）
    ├─ 需要 compact → 写入 handoff.md + 追加 index.jsonl
    └─ 返回 messages（本 Plugin 不修改消息内容）
    ↓
@cline/core API-safety message builder（最终保护）
    ↓
provider 调用
```

### 双产物输出

| 产物 | 路径 | 格式 | 用途 |
|------|------|------|------|
| handoff.md | `~/.cline/data/handoff/<sessionId>.md` | Markdown | 人工可读的会话快照 |
| index.jsonl | `~/.cline/data/handoff/index.jsonl` | JSONL（append-only）| 机器可读的索引层 |

### 提取信息

- **决策信号**：从 user 消息中匹配 `decision / accept / reject / adopt / rollback / defer` 关键词
- **未完成项**：匹配 `todo / unfinished / next / remaining / still need` 关键词
- **工具使用**：`collectToolNames()` 从工具调用中汇总
- **文件改动**：`collectTouchedFiles()` 从 file blocks 和 tool inputs 中汇总

## 安装

```bash
cline plugin install https://github.com/zk-0808/cline-plugin-install --cwd .
```

安装后 Customize 面板应显示 `handoff-plugin` 已加载。

## 验证

### 1. Plugin 加载标记

Plugin 的 `setup()` 会在 `~/.cline/data/handoff/` 写入 `plugin-loaded.marker` 文件：

```bash
type %USERPROFILE%\.cline\data\handoff\plugin-loaded.marker
```

### 2. 触发 Compact 验证

进行长对话（约 90K+ token），触发 Cline 原生 compact。检查产物：

```bash
dir %USERPROFILE%\.cline\data\handoff\*.md
type %USERPROFILE%\.cline\data\handoff\index.jsonl
```

### 3. 日志（调试用）

VS Code 开发者 Console 中不会显示 `console.log`（sandbox 子进程日志走内部 bridge），Plugin 内部日志可通过 Cline 的 logger bridge 查看。

## 设计文档

详见 [docs/design-handoff-plugin.md](../docs/design-handoff-plugin.md)（9 章，含触发条件、双产物 schema、降级行为、与 #6 Resume Plugin 的关系、Risk 与 Open Questions）。

## 上游决策

- [ADR-001](../docs/decisions/ADR-001-handoff-compact-memory.md) — 方向决策（Accepted，三方向：A+B'+D'）
- [ADR-004](../docs/decisions/ADR-004-p5-spike-pause.md) — 暂停决策（deferred，本 Plugin 满足其恢复条件 2）
- [Capability Probe 5](../docs/decisions/investigation-note-probe-5.md) — 前置验证证据
- [custom-compaction.ts](https://github.com/cline/cline/blob/main/sdk/examples/plugins/custom-compaction.ts) — 设计母本

## 未完成项

- Phase 3：index.jsonl 字段补齐（summary + key_terms + decision_count）
- Phase 4：VS Code 扩展端全链路闭环验证
- #6 Resume Plugin（依赖本 Plugin 产出数据，`session_start` hook 读取 index.jsonl 注入 handoff）
