import { Link } from "@/lib/router";
import { AgentIcon } from "./AgentIconPicker";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { deriveProjectUrlKey, type ActivityEvent, type Agent } from "@paperclipai/shared";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import {
  FileText,
  UserPlus,
  Loader2,
  Package,
  User,
  Settings,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Tier 1 "verb phrase" — short label after "{Actor}" on the meta line. */
function actionLabel(action: string, details?: Record<string, unknown> | null): string {
  switch (action) {
    case "issue.created":
      return "created a task";
    case "issue.document_created":
      return "created a document";
    case "issue.document_updated":
      return "updated a document";
    case "issue.updated": {
      const status = details?.status as string | undefined;
      if (status === "in_review") return "submitted for review";
      return "updated task";
    }
    case "approval.created":
      return "submitted for approval";
    case "approval.approved":
      return "approved";
    case "approval.rejected":
      return "requested changes";
    case "issue.work_product_created":
      return "delivered a work product";
    case "agent.created":
      return "new agent created";
    default:
      return action.replace(/[._]/g, " ");
  }
}

/** Tier 2 verbs — read inline with the object name ("paused CTO Agent"). */
const ACTION_VERBS: Record<string, string> = {
  "issue.created": "created",
  "issue.updated": "updated",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "issue.comment_added": "commented on",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.document_created": "created document for",
  "issue.document_updated": "updated document on",
  "issue.document_deleted": "deleted document from",
  "issue.commented": "commented on",
  "issue.deleted": "deleted",
  "issue.work_product_updated": "updated work product on",
  "issue.work_product_deleted": "deleted work product from",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.paused": "paused",
  "agent.resumed": "resumed",
  "agent.terminated": "terminated",
  "agent.key_created": "created API key for",
  "agent.budget_updated": "updated budget for",
  "agent.runtime_session_reset": "reset session for",
  "heartbeat.invoked": "invoked heartbeat for",
  "heartbeat.cancelled": "cancelled heartbeat for",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "project.created": "created",
  "project.updated": "updated",
  "project.deleted": "deleted",
  "goal.created": "created",
  "goal.updated": "updated",
  "goal.deleted": "deleted",
  "cost.reported": "reported cost for",
  "cost.recorded": "recorded cost for",
  "company.created": "created company",
  "company.updated": "updated company",
  "company.archived": "archived",
  "company.budget_updated": "updated budget for",
};

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function formatVerb(action: string, details?: Record<string, unknown> | null): string {
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    if (details.status !== undefined) {
      const from = previous.status;
      return from
        ? `changed status from ${humanizeValue(from)} to ${humanizeValue(details.status)} on`
        : `changed status to ${humanizeValue(details.status)} on`;
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      return from
        ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)} on`
        : `changed priority to ${humanizeValue(details.priority)} on`;
    }
  }
  return ACTION_VERBS[action] ?? action.replace(/[._]/g, " ");
}

/** Map action → task status for the Tier 1 status circle indicator */
function deriveTaskStatus(action: string, details?: Record<string, unknown> | null): string | null {
  switch (action) {
    case "issue.created":
      return "todo";
    case "issue.updated": {
      const status = details?.status as string | undefined;
      return status ?? null;
    }
    case "issue.document_created":
    case "issue.document_updated":
      return "in_progress";
    case "issue.work_product_created":
      return "in_review";
    case "approval.created":
      return "in_review";
    case "approval.approved":
      return "done";
    case "approval.rejected":
      return "blocked";
    default:
      return null;
  }
}

function entityLink(entityType: string, entityId: string, name?: string | null): string | null {
  switch (entityType) {
    case "issue": return `/issues/${name ?? entityId}`;
    case "agent": return `/agents/${entityId}`;
    case "project": return `/projects/${deriveProjectUrlKey(name, entityId)}`;
    case "goal": return `/goals/${entityId}`;
    case "approval": return `/approvals/${entityId}`;
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Status Circle — matches StatusIcon rendering                       */
/* ------------------------------------------------------------------ */

function StatusCircle({ status, className }: { status: string; className?: string }) {
  const colorClass = issueStatusIcon[status] ?? issueStatusIconDefault;
  return (
    <span className={cn("relative inline-flex h-4 w-4 rounded-full border-2 shrink-0", colorClass, className)}>
      {status === "done" && (
        <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Actor Icon                                                         */
/* ------------------------------------------------------------------ */

function ActorIcon({
  event,
  agentMap,
  overrideAgent,
}: {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  overrideAgent?: Agent | null;
}) {
  if (overrideAgent) {
    return <AgentIcon icon={overrideAgent.icon ?? null} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  if (event.actorType === "agent") {
    const agent = agentMap.get(event.actorId);
    return <AgentIcon icon={agent?.icon ?? null} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  if (event.actorType === "user") {
    return <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface FeedCardProps {
  event: ActivityEvent;
  agentMap: Map<string, Agent>;
  entityNameMap: Map<string, string>;
  entityTitleMap?: Map<string, string>;
  entityStatusMap?: Map<string, string>;
  isActive?: boolean;
  /** 1 = two-line rich card (default). 2 = one-line compact card. */
  tier?: 1 | 2;
  className?: string;
}

export function FeedCard({
  event,
  agentMap,
  entityNameMap,
  entityTitleMap,
  entityStatusMap,
  isActive,
  tier = 1,
  className,
}: FeedCardProps) {
  const actor = event.actorType === "agent" ? agentMap.get(event.actorId) : null;
  const details = event.details as Record<string, unknown> | null;
  const entityTitle = entityTitleMap?.get(`${event.entityType}:${event.entityId}`);

  // Attribution override: the Board concierge chat runs as the user, so any
  // documents it drafts inside a Conference Room conversation get logged
  // with actorType="user" ("Board"). Re-attribute those to the CEO agent
  // so the feed reads naturally.
  const isBoardOpsDocEvent =
    event.entityType === "issue" &&
    event.actorType === "user" &&
    (event.action === "issue.document_created" ||
      event.action === "issue.document_updated") &&
    entityTitle === "Board Operations";
  const ceoOverride: Agent | null = isBoardOpsDocEvent
    ? Array.from(agentMap.values()).find(
        (a) => a.role === "ceo" && a.status !== "terminated",
      ) ?? null
    : null;

  const displayActor = ceoOverride ?? actor;
  const actorName = displayActor?.name
    ?? (event.actorType === "system" ? "System"
      : event.actorType === "user" ? "Board"
      : event.actorId || "Unknown");

  // Heartbeat events live on `heartbeat_run` with agentId in details —
  // resolve the display name from the agent, and link to the run page.
  const isHeartbeatEvent = event.entityType === "heartbeat_run";
  const heartbeatAgentId = isHeartbeatEvent
    ? (details?.agentId as string | undefined)
    : undefined;

  const entityName = isHeartbeatEvent
    ? (heartbeatAgentId ? entityNameMap.get(`agent:${heartbeatAgentId}`) : undefined)
    : entityNameMap.get(`${event.entityType}:${event.entityId}`);

  /* ---------------- Link resolution ---------------- */

  const docKey = details?.key as string | undefined;
  const summary = details?.summary as string | undefined;
  const isDocEvent =
    event.action === "issue.document_created" || event.action === "issue.document_updated";
  const issueSlug = entityName ?? event.entityId;
  const hiredAgentId = details?.hiredAgentId as string | undefined;
  const approvalLink =
    event.action === "approval.approved" && hiredAgentId
      ? `/agents/${hiredAgentId}`
      : `/approvals/${event.entityId}`;

  const link = isHeartbeatEvent && heartbeatAgentId
    ? `/agents/${heartbeatAgentId}/runs/${event.entityId}`
    : event.entityType === "issue"
      ? isDocEvent && docKey
        ? `/issues/${issueSlug}#document-${encodeURIComponent(docKey)}`
        : `/issues/${issueSlug}`
      : event.entityType === "agent"
        ? `/agents/${event.entityId}`
        : event.entityType === "approval"
          ? approvalLink
          : entityLink(event.entityType, event.entityId, entityName);

  /* ---------------- Shared shell classes ---------------- */

  const shellBase =
    "mx-3 rounded-lg border bg-card transition-[background-color,border-color,transform] duration-150";
  const hoverClasses = link
    ? "cursor-pointer hover:bg-accent hover:border-muted-foreground/30 hover:-translate-y-px"
    : "";

  const wrap = (cardContent: React.ReactNode) => {
    if (link) {
      return (
        <Link to={link} className="no-underline text-inherit block">
          {cardContent}
        </Link>
      );
    }
    return cardContent;
  };

  /* ---------------- Tier 2 render ---------------- */

  if (tier === 2) {
    const verb = formatVerb(event.action, details);
    const card = (
      <div className={cn(shellBase, "my-1.5 px-3 py-1.5 text-xs", hoverClasses, className)}>
        <div className="flex items-center gap-2 min-w-0">
          <ActorIcon event={event} agentMap={agentMap} overrideAgent={ceoOverride} />
          <span className="flex-1 min-w-0 truncate text-muted-foreground">
            <span className="font-medium text-foreground">{actorName}</span>
            <span className="ml-1">{verb}</span>
            {entityName && <span className="ml-1">{entityName}</span>}
            {entityTitle && <span className="ml-1">— {entityTitle}</span>}
          </span>
          {isActive && <Loader2 className="h-3 w-3 shrink-0 text-amber-500 animate-spin" />}
          <span className="font-mono text-muted-foreground shrink-0">
            {timeAgo(event.createdAt)}
          </span>
        </div>
      </div>
    );
    return wrap(card);
  }

  /* ---------------- Tier 1 render ---------------- */

  // Approval display context
  const isApprovalEvent = event.entityType === "approval";
  const approvalAgentId = details?.requestedByAgentId as string | undefined;
  const approvalAgentName = approvalAgentId ? agentMap.get(approvalAgentId)?.name : undefined;

  const eventStatus = deriveTaskStatus(event.action, details);
  const currentStatus = entityStatusMap?.get(`${event.entityType}:${event.entityId}`) ?? null;
  const taskStatus = currentStatus ?? eventStatus;
  const isAgentEvent = event.action === "agent.created";
  const isWorkProductEvent = event.action === "issue.work_product_created";

  const approvalType = details?.type as string | undefined;
  const approvalFallbackTitle =
    approvalType === "agent_hire"
      ? "Agent hire"
      : approvalType
        ? `Approval · ${approvalType}`
        : "Approval request";

  // Identifier line content. For issue events, prefer "{slug} {title}" so the
  // mono line reads like a concrete identifier (e.g. "FAM-4 Write AGENTS.md").
  const isIssueEvent = event.entityType === "issue";
  const identifierText = isAgentEvent
    ? (details?.name as string | undefined) ?? entityName ?? event.entityId
    : isApprovalEvent
      ? approvalAgentName ?? entityTitle ?? entityName ?? approvalFallbackTitle
      : isDocEvent && docKey
        ? docKey
        : isIssueEvent && entityName && entityTitle
          ? `${entityName} ${entityTitle}`
          : entityTitle ?? entityName ?? event.entityId;

  const renderStatusIndicator = () => {
    if (isActive) {
      return <Loader2 className="h-4 w-4 shrink-0 text-amber-500 animate-spin" />;
    }
    if (isAgentEvent) {
      return <UserPlus className="h-4 w-4 shrink-0 text-purple-500" />;
    }
    if (isDocEvent) {
      return <FileText className="h-4 w-4 shrink-0 text-blue-500" />;
    }
    if (isWorkProductEvent) {
      return <Package className="h-4 w-4 shrink-0 text-indigo-500" />;
    }
    if (taskStatus) {
      return <StatusCircle status={taskStatus} />;
    }
    return <StatusCircle status="backlog" />;
  };

  const card = (
    <div className={cn(shellBase, "my-2 p-3 text-xs", hoverClasses, className)}>
      {/* Meta line: actor icon + name + verb + timestamp */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <ActorIcon event={event} agentMap={agentMap} overrideAgent={ceoOverride} />
          <span className="text-xs font-medium truncate text-muted-foreground">{actorName}</span>
          <span className="text-muted-foreground truncate text-xs">
            {actionLabel(event.action, details)}
          </span>
        </div>
        <span className="font-mono text-xs text-muted-foreground shrink-0">
          {timeAgo(event.createdAt)}
        </span>
      </div>

      {/* Identifier line: status glyph + mono identifier */}
      <div className="flex items-center gap-2 font-mono text-sm text-foreground">
        {renderStatusIndicator()}
        <span className="truncate">{identifierText}</span>
      </div>

      {/* Optional summary (Inter, muted) */}
      {summary && (
        <p className="mt-1.5 text-xs text-muted-foreground line-clamp-2">
          {summary}
        </p>
      )}
    </div>
  );

  return wrap(card);
}
