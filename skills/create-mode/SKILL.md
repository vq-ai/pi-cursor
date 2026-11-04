---
name: create-mode
description: Create a custom agent mode alongside Ask, Plan, Debug and Implement. Use when the user wants a persistent working style for their main conversation.
---

# Create a custom mode

A mode changes how the main conversation behaves until the user switches again. Use a custom agent instead for one-off delegated work.

Modes are markdown files in `.pi/modes/` or `.cursor/modes/` (project), or `~/.pi/agent/modes/` or `~/.cursor/modes/` (user). The body is added to the system prompt.

```markdown
---
name: docs
description: Write and improve documentation
icon: ✎
readonly: false
tools: read, grep, find, ls, edit, write
model: anthropic/claude-sonnet-4-5
thinking: low
---

You are in Docs mode. Change only documentation files. Keep the existing voice.
```

All fields except `name` and `description` are optional. `readonly: true` enforces read-only at the tool level, and `tools` limits what is available. The mode then appears in the Shift+Tab cycle and `/mode`. Run `/reload` after adding one.
