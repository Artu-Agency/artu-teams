import { cn } from "../lib/utils";

interface MachineStatusBadgeProps {
  status: "online" | "offline";
}

export function MachineStatusBadge({ status }: MachineStatusBadgeProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex h-2.5 w-2.5">
        {status === "online" && (
          <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex rounded-full h-2.5 w-2.5",
            status === "online" ? "bg-emerald-500" : "bg-red-500",
          )}
        />
      </span>
      <span
        className={cn(
          "text-xs font-medium capitalize",
          status === "online"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-red-600 dark:text-red-400",
        )}
      >
        {status}
      </span>
    </span>
  );
}
