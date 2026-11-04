---
description: Break a task into independent pieces and run them with parallel agents
argument-hint: "<task>"
---
Split this task into independent pieces that do not touch the same files, then run one general-purpose agent per piece at the same time with task_group in parallel mode. Give each agent a complete prompt. If the pieces overlap, use `isolation: "worktree"` for each and apply the results one at a time. When they finish, check that the combined result works and report what was done.

Task: $@
