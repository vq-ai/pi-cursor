---
name: create-subagent
description: Create a custom sub-agent. Use when the user wants a specialized agent such as a reviewer or debugger, or asks about .cursor/agents.
---

# Create a custom agent

Agents are markdown files in `.cursor/agents/` (project, higher priority) or `~/.cursor/agents/` (user). The body becomes the agent's system prompt.

## Format

```markdown
---
name: api-reviewer
description: Reviews API changes for compatibility and error handling. Use after changing anything under src/api.
model: inherit
readonly: true
---

You review API changes. When invoked:
1. Run git diff on src/api.
2. Check compatibility, status codes and input validation.

Report problems as path:line, what goes wrong and the fix.
```

## Fields

| Field | Values | Meaning |
|---|---|---|
| `name` | lowercase and hyphens | Unique ID, also its `/name` command |
| `description` | text | When to delegate to it. This decides whether it gets used, so name the situations |
| `model` | `inherit`, `fast` or a model name | Which model it runs on. Default: `inherit` |
| `readonly` | `true`, `false` | Forbid changes, enforced at the tool level |
| `is_background` | `true`, `false` | Run in the background by default |
| `tools` | comma list | Restrict its tools (optional) |
| `isolation` | `worktree` | Always run in its own git worktree (optional) |
| `max_turns` | number | Stop after this many model turns (optional) |

## Guidance

- Give each agent one job. Say what it should do first, and exactly what to report back, since its final message is all the parent receives.
- It does not see the parent's conversation.
- Use `readonly: true` for anything that only analyzes.

After writing the file, tell the user they can run it with `/name <task>` or by asking for it, and see it in `/agents`.
