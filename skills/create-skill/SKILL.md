---
name: create-skill
description: Create a reusable agent skill. Use when the user wants to capture a workflow or specialized knowledge, or asks about SKILL.md or .cursor/skills.
---

# Create a skill

A skill is a directory holding a `SKILL.md`, in `.cursor/skills/<name>/` (project) or `~/.cursor/skills/<name>/` (user). The agent sees only the name and description until the skill is needed, so a skill costs little context.

## Format

```markdown
---
name: release-notes
description: Write release notes from git history in the team's format. Use when preparing a release or asked for a changelog.
---

# Release notes

Steps the agent should follow, then any reference it needs.
```

- `name`: lowercase letters, numbers and hyphens, matching the directory name.
- `description`: what it does and when to use it. This decides whether it gets loaded, so include the words a user would actually say.
- `disable-model-invocation: true`: only run when invoked explicitly as `/name`.

## Guidance

- Put the instructions in `SKILL.md`, and move long reference material to other files in the directory, linked with relative paths, so they are read only if needed.
- Put scripts in `scripts/`. Prefer a script over prose when the steps must be exact.
- If the user gives exact wording, use it verbatim.

After writing it, run `/reload` so that Pi picks it up, then try it with `/name`.
