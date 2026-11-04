---
name: create-rule
description: Create a project or user rule. Use when the user wants to add coding standards, conventions or persistent guidance, or asks about .cursor/rules or AGENTS.md.
---

# Create a rule

Rules live in `.cursor/rules/*.mdc` (project) or `~/.cursor/rules/*.mdc` (user). Pi with pi-cursor reads them the same way Cursor does, so a rule written here works in both.

Work out from the conversation what the rule should enforce and when it applies. Ask only about what you cannot infer; use ask_question for the scope if it is unclear.

## Format

```markdown
---
description: What this rule covers, written so that it is clear when it applies
globs: src/**/*.ts
alwaysApply: false
---

# Title

Guidance goes here. Prefer concrete examples over abstract advice.
```

## The four kinds of rule

| Kind | Frontmatter | When the agent sees it |
|---|---|---|
| Always | `alwaysApply: true` | Every request |
| Glob | `globs: ...` | As soon as a matching file is mentioned or touched |
| On request | `description` only | The agent reads it when the description fits the task |
| Manual | Neither | Only when mentioned as `@rule-name` |

A rule in a subdirectory's `.cursor/rules` applies only to files under that directory, and its globs are relative to it.

## Guidance

- Keep one concern per rule, and keep each rule short. Long rules cost context on every request they apply to.
- Choose glob or on-request rules over always-on rules where you can.
- Show what good looks like with a small example from this codebase.

After writing the file, tell the user what kind of rule it is and when it will apply. Run `/rules` to see it.
