import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { machinesApi, type Machine } from "../api/machines";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { MachineStatusBadge } from "./MachineStatusBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";

function usageColor(value: number): string {
  if (value >= 80) return "bg-red-500";
  if (value >= 50) return "bg-yellow-500";
  return "bg-emerald-500";
}

function usageTextColor(value: number): string {
  if (value >= 80) return "text-red-400";
  if (value >= 50) return "text-yellow-400";
  return "text-emerald-400";
}

function adapterStatusColor(status: string): string {
  if (status === "available") return "text-emerald-400";
  if (status === "busy") return "text-yellow-400";
  return "text-red-400";
}

function relativeTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function UsageBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-8 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", usageColor(value))}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      <span className={cn("text-xs font-mono w-10 text-right", usageTextColor(value))}>
        {Math.round(value)}%
      </span>
    </div>
  );
}

interface MachineCardProps {
  machine: Machine;
}

export function MachineCard({ machine }: MachineCardProps) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);

  const removeMutation = useMutation({
    mutationFn: () => machinesApi.remove(selectedCompanyId!, machine.id),
    onSuccess: () => {
      pushToast({ tone: "success", title: `Machine "${machine.name}" removed.` });
      queryClient.invalidateQueries({ queryKey: queryKeys.machines.list(selectedCompanyId!) });
      setShowRemoveDialog(false);
    },
    onError: (err: Error) => {
      pushToast({ tone: "error", title: err.message || "Failed to remove machine." });
    },
  });

  const isOnline = machine.status === "online";

  return (
    <>
      <div className="border border-border p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{machine.name}</span>
              <MachineStatusBadge status={machine.status} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {machine.hostname} &middot; {machine.os} {machine.arch}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive shrink-0"
            onClick={() => setShowRemoveDialog(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Metrics or last seen */}
        {isOnline && machine.cpuUsage != null && machine.memoryUsage != null ? (
          <div className="space-y-1.5">
            <UsageBar label="CPU" value={machine.cpuUsage} />
            <UsageBar label="RAM" value={machine.memoryUsage} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {machine.lastSeenAt
              ? `Last seen: ${relativeTimeAgo(machine.lastSeenAt)}`
              : "Never connected"}
          </p>
        )}

        {/* Adapters */}
        {machine.adapters && machine.adapters.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
              Adapters
            </span>
            <div className="space-y-0.5">
              {machine.adapters.map((adapter) => (
                <div key={adapter.id} className="flex items-center gap-2 text-xs">
                  <span className={cn("font-medium", adapterStatusColor(adapter.status))}>
                    &bull;
                  </span>
                  <span className="text-muted-foreground truncate">
                    {adapter.adapterType}
                    {adapter.model ? ` — ${adapter.model}` : ""}
                  </span>
                  <span className={cn("ml-auto text-[11px] capitalize", adapterStatusColor(adapter.status))}>
                    {adapter.status}
                  </span>
                  {adapter.status === "busy" && adapter.currentTaskId && (
                    <span className="text-[11px] text-blue-400 font-mono truncate max-w-[80px]">
                      {adapter.currentTaskId.slice(0, 8)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Remove confirmation dialog */}
      <Dialog open={showRemoveDialog} onOpenChange={setShowRemoveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove machine</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove <strong>{machine.name}</strong>? This will
              disconnect the machine and remove it from this company.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRemoveDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
