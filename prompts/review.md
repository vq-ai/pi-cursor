---
description: Review the current changes for bugs and security problems, using parallel read-only agents
argument-hint: "[what to focus on]"
---
Review my current changes (`git diff`, plus staged changes; if there are none, the last commit). Run the code-reviewer and security-review agents in parallel with the task tool, passing each the scope. Focus especially on: ${@:-correctness and security}.

Then combine their findings into one list, most severe first, verify each one against the code, and drop any you cannot confirm. For each finding give the location, what goes wrong and the fix. Do not change anything until I ask.
