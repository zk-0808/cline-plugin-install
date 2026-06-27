# Auto Handoff

在 Cline compact 事件触发时自动生成 handoff.md + index.jsonl。

## 原理

通过 `registerMessageBuilder` 挂钩 Cline 原生 compact 流程：

1. token 达到 75% 阈值时触发
2. 保留首条 user message + 最近 24K token
3. 中间历史替换为摘要 + **自动写出 handoff.md**
4. 同一条目追加到 index.jsonl

## 安装

```bash
cline plugin install https://github.com/zk-0808/cline-plugin-install --cwd .
```

## 验证

```bash
cat ~/.cline/data/handoff/plugin-loaded.marker
```

触发一次 compact（长对话）后检查产物：

```bash
ls ~/.cline/data/handoff/
```
