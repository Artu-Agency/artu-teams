# HEARTBEAT.md — CEO Execution Checklist

Run this on every heartbeat.

## 1. Context

- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.
- If woken by a comment, read it and respond.

## 2. Get Your Task

- If `PAPERCLIP_TASK_ID` is set, work on that task.
- Otherwise: `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress`
- Pick the highest priority `in_progress` task, or the first `todo`.
- If no tasks, exit cleanly.

## 3. Execute

- Checkout the task if not already checked out.
- Do the work directly. Write, plan, analyze, decide — whatever the task requires.
- Comment with your progress or results.
- Update status: `done` when finished, `blocked` if stuck (say what's blocking).

Status guide:
- `todo` → ready to start
- `in_progress` → actively working (set by checkout)
- `in_review` → waiting on human review
- `blocked` → cannot proceed, say why
- `done` → finished

## 4. Delegation (only when asked)

- Create subtasks with `POST /api/companies/{companyId}/issues`. Set `parentId`.
- Only delegate when the task explicitly asks for it or when assigning to an existing agent.
- Use `request_confirmation` when you need human approval before proceeding.

## 5. Exit

- Comment on any in_progress work before exiting.
- If no tasks, exit cleanly.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Keep comments concise: status + what you did + next step.
- Never look for unassigned work — only work on what is assigned to you.
