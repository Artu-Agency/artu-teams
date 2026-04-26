import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Monitor, Plus } from "lucide-react";
import { machinesApi } from "../api/machines";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MachineCard } from "../components/MachineCard";
import { AddMachineModal } from "../components/AddMachineModal";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";

export function Machines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [addModalOpen, setAddModalOpen] = useState(false);

  const { data: machines, isLoading, error } = useQuery({
    queryKey: queryKeys.machines.list(selectedCompanyId!),
    queryFn: () => machinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Machines" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Monitor} message="Select a company to view machines." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Machines</h1>
        <Button size="sm" variant="outline" onClick={() => setAddModalOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Machine
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {machines && machines.length === 0 && (
        <EmptyState
          icon={Monitor}
          message="No machines connected. Add a machine to start running tasks."
          action="Add Machine"
          onAction={() => setAddModalOpen(true)}
        />
      )}

      {machines && machines.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            {machines.length} machine{machines.length !== 1 ? "s" : ""}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {machines.map((machine) => (
              <MachineCard key={machine.id} machine={machine} />
            ))}
          </div>
        </>
      )}

      <AddMachineModal open={addModalOpen} onOpenChange={setAddModalOpen} />
    </div>
  );
}
