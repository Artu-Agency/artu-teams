# Agent Profile Dashboard — Brief

## Purpose

Redesign the Dashboard tab of the Agent Profile page to give users clearer hierarchy and more efficient information parsing. This is Run A of a two-path experiment — Claude Code path. Run B (Paperclip agent teams) runs from this same brief and rubric.

## Operating principles

Both runs work from a shared set of UX operating principles documented in [`./operating-principles.md`](./operating-principles.md). These cover role definition, design lenses (cognition, Gestalt, usability heuristics, accessibility, etc.), the visual quality bar, the "reach for what exists first" DS discipline, and general working rules. Both runs apply these principles to the work; path-specific operational mechanics (how each path coordinates, reports, or executes internally) live outside the shared baseline.

## Current state

The Dashboard tab is rendered by `AgentOverview` (lines 1259–1335) and its inline helpers `LatestRunCard` (1170–1255) and `CostsSection` (1339–1413) inside `ui/src/pages/AgentDetail.tsx`. Effective footprint is ~245 lines across three inline functions.

It renders a vertically-stacked column: live/latest run card → 4-up "last 14 days" charts grid (Run Activity, Issues by Priority, Issues by Status, Success Rate) → Recent Issues list with up to 10 rows → Costs section with a KPI strip and a per-run cost table. The visual language is sharp-cornered, sparse typography, with live-run state communicated by a cyan pulse and soft glow on an otherwise neutral card.

See `./reference/` for screenshots of the current dashboard. Note that the full-page screenshots (`00-screenshot-idle.png`, `01-screenshot-live-run.png`) were captured at 50% zoom to fit content; real viewing scale is 2x denser per-element. Refer to close-ups (`02`–`04`) for accurate element sizing.

## Who uses this and when

The dashboard is viewed across four mental modes, **prioritized** as follows:

- **Monitoring (primary)** — a designer checking whether their website-builder agent is running and what task it's on; a teammate scanning an agent's in-flight work. Optimize for this mode first.
- **Operations (secondary)** — a teammate wanting to manually override which task the agent works on next.
- **Accountability (secondary)** — a manager checking how much a specific agent is spending on a specific task; an engineer watching token consumption.
- **Debug (secondary)** — an engineer investigating when and why a task failed.

Secondary modes must be served without cluttering the primary mode. When modes conflict, monitoring wins.

The dashboard is a **lens** into agent state — not the canonical home for any of the data it shows. Users go to other surfaces (run detail, issues list, task workspace) for deep work. The dashboard's job is to surface what matters right now and route to detail elsewhere.

## Design goal

**A user in monitoring mode should be able to answer "is this agent healthy and what is it doing right now" without scrolling, on a 1440px-wide screen.**

That's the design's first obligation. Everything else — operations controls, spend visibility, debug affordances — must be present and reachable but must not interfere with this goal.

## Required metrics

The dashboard must surface both (a) **budget position** — the agent's current standing against its budget (observed vs. allowed, utilization, remaining), and (b) **session burn rate** — recent cost activity against the current session (cumulative cost and per-run cost over the recent window).

Budget position must fit in the monitoring-no-scrolling frame (it's the signal the primary-goal test is evaluated against). Session burn rate must also be present on the dashboard but may live in a secondary surface (for example, integrated with the costs section) rather than the top-of-page summary.

## Problems to solve

1. **No clear hierarchy.** Everything on the page reads with roughly equal weight. Users can't tell at a glance what's most important.
2. **Uneven chart value.** The dashboard shows four charts ("last 14 days" Run Activity, Issues by Priority, Issues by Status, Success Rate). Their value to users varies — each should either earn its place against specific user decisions or be consolidated. The current layout treats all four as equally important, which obscures the ones that do real work.
3. **Cost/token split is awkward.** Two adjacent tables (costs KPI strip + per-run costs) split what's probably one coherent accountability surface into two.

## Design direction

Favor hierarchy over comprehensiveness. Combining, merging, or consolidating modules is encouraged where it serves the monitoring goal. All current data must remain reachable — a chart can be merged, filtered, or tucked behind a secondary view, but no user can be left unable to find information they need for their mode. "Reachable" means within two interactions (click, expand, filter) from the default dashboard view.

## Scope — in

Affirmative scope — what this redesign must do:

- Redesign the content and structure of `AgentOverview`, `LatestRunCard`, and `CostsSection` inside `ui/src/pages/AgentDetail.tsx` (approximately lines 1170–1413)
- **Preserve visual distinction for live-running agents.** The current cyan-pulse treatment on the Live Run card is the load-bearing signal for "this agent is alive right now." Replacing it requires an equally clear alternative signal.
- **Surface two named action affordances on the dashboard:**
  - **Change task priority** — drag-and-drop between priority buckets or explicit priority selector, scoped to the top 5–10 in-flight tasks. Short note: the backend does not support arbitrary reordering, so the operations use case is served by priority elevation rather than position. Priority is a closed 4-value enum (`critical | high | medium | low`), so this is a promote/demote action across four buckets, not free ordering.
  - **Navigate to run/task/issue detail** — preserve current link-based navigation via cards and rows unless a better affordance is clearly warranted.
- **Pause agent is out of scope for this redesign.** Pause is handled by the existing page-chrome control (`PauseResumeButton` in the page header), which already satisfies the single-click/reversible/no-confirmation semantics. It is not duplicated on the dashboard.
- **Keep all current data reachable.** Merging and reorganizing is encouraged; omission is not.

## Scope — out

What this redesign does not touch:

- **No extraction or refactoring** of `AgentOverview` / `LatestRunCard` / `CostsSection` into separate files. Work within the inline structure.
- **No chart tokenization.** Use hardcoded hex for chart colors, matching current behavior.
- **No other profile tabs.** Dashboard tab only.
- **No destructive actions** (terminate, delete, archive) on the dashboard.
- **No approve/reject flows** on the dashboard.
- **No changes to `status-colors.ts`.**
- **No new tokens proposed mid-experiment.** Use only tokens shipped in Step 0.
- **No merging of duplicate component families** flagged in `doc/design-system/components/components-review.md`. Use what exists.

## Design system policy

- **Sharp corners** (`rounded-none`) for dashboard surfaces. `rounded-lg` (0.625rem) and `rounded-xl` (0.75rem) are available for opt-in rounded surfaces if genuinely warranted (e.g., a chat-like element), but the dashboard aesthetic is sharp.
- **`--signal-success` / `--signal-success-foreground`** for approve/confirm actions if they appear.
- **`destructive` / `destructive-foreground`** is reserved for terminate/reject — but those are out of scope for the dashboard, so this is unlikely to apply.
- **`status-colors.ts`** is the source of truth for entity state colors. Use as-is.

## Deliverables

A working redesigned Agent Profile Dashboard rendered at `/agents/[agentId]` default view, plus any necessary changes to the three in-scope inline functions. No new files, no component extraction, no tests of what already worked. The redesign should be reviewable against the rubric.
