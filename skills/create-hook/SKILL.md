---
name: create-hook
description: Create an agent hook that runs a script around agent events. Use when the user wants to block or audit commands, format files after edits, or automate anything "whenever the agent does X". Also for questions about hooks.json.
---

# Create a hook

Hooks live in `.cursor/hooks.json` (project; commands run from the project root) or `~/.cursor/hooks.json` (user; commands run from `~/.cursor`). Pi asks the user to approve project hooks before they run.

```json
{
  "version": 1,
  "hooks": {
    "afterFileEdit": [{ "command": ".cursor/hooks/format.sh" }],
    "beforeShellExecution": [{ "command": ".cursor/hooks/guard.sh", "matcher": "rm |curl ", "failClosed": true }]
  }
}
```

A hook receives JSON on stdin and may print JSON on stdout. Exit code 2 blocks the action. Other failures are ignored unless `failClosed` is true.

## Events

| Event | Input includes | Output it can return |
|---|---|---|
| `sessionStart`, `sessionEnd` | `session_id`, `reason` | `additional_context` (start) |
| `beforeSubmitPrompt` | `prompt` | `continue`, `user_message` |
| `preToolUse` | `tool_name`, `tool_input` | `permission`, `user_message`, `agent_message`, `updated_input` |
| `postToolUse`, `postToolUseFailure` | `tool_name`, `tool_output` or `error_message` | `additional_context` |
| `beforeShellExecution`, `afterShellExecution` | `command`, `output` (after) | `permission`, `user_message`, `agent_message` (before) |
| `beforeMCPExecution`, `afterMCPExecution` | `tool_name`, `tool_input` | `permission`, `user_message`, `agent_message` (before) |
| `beforeReadFile` | `file_path`, `content` | `permission` |
| `afterFileEdit` | `file_path`, `edits` | nothing |
| `subagentStart`, `subagentStop` | `subagent_type`, `task`, `status`, `result` | `permission` (start), `followup_message` (stop) |
| `preCompact` | `trigger` | nothing |
| `stop` | `status`, `loop_count` | `followup_message` (continues the agent, up to `loop_limit`) |
| `afterAgentResponse`, `afterAgentThought` | `text` | nothing |

`permission` is `allow`, `deny` or `ask`. Matchers are JavaScript regular expressions, tested against the tool type (`Shell`, `Read`, `Write`, `Task`, `MCP: name`), the command, or the sub-agent name, depending on the event.

Every hook also receives `conversation_id`, `generation_id`, `model`, `hook_event_name`, `workspace_roots` and `transcript_path`, plus the `CURSOR_PROJECT_DIR` environment variable.

## Options

`timeout` (seconds), `matcher`, `failClosed`, `loop_limit`, and `type: "prompt"` with a `prompt` field, which asks the model to judge a policy; `$ARGUMENTS` is replaced by the input.

## Steps

1. Choose the narrowest event, and start with no matcher or a simple one.
2. Write the script, make it executable, and check that every program it calls is installed.
3. Trigger the event for real, then check `/hooks`, which shows loaded hooks and recent runs. Hooks load at session start, so run `/reload` after editing them.
