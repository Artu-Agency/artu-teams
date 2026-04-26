import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2 } from "lucide-react";
import { machinesApi, type Machine } from "../api/machines";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { API_BASE } from "../api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AddMachineModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddMachineModal({ open, onOpenChange }: AddMachineModalProps) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const initialMachineCountRef = useRef<number | null>(null);

  const inviteMutation = useMutation({
    mutationFn: () => machinesApi.createInvite(selectedCompanyId!),
  });

  // Request invite when modal opens
  useEffect(() => {
    if (open && selectedCompanyId && !inviteMutation.data && !inviteMutation.isPending) {
      inviteMutation.mutate();
    }
    if (!open) {
      inviteMutation.reset();
      initialMachineCountRef.current = null;
      setCopied(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedCompanyId]);

  // Poll for new machine connections
  const { data: machines } = useQuery({
    queryKey: queryKeys.machines.list(selectedCompanyId!),
    queryFn: () => machinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && open && !!inviteMutation.data,
  });

  // Track initial count and detect new machines
  useEffect(() => {
    if (!machines || !open) return;
    if (initialMachineCountRef.current === null) {
      initialMachineCountRef.current = machines.length;
      return;
    }
    if (machines.length > initialMachineCountRef.current) {
      pushToast({ tone: "success", title: "Machine connected successfully!" });
      queryClient.invalidateQueries({ queryKey: queryKeys.machines.list(selectedCompanyId!) });
      onOpenChange(false);
    }
  }, [machines, open, selectedCompanyId, pushToast, queryClient, onOpenChange]);

  const serverUrl = API_BASE.startsWith("http") ? API_BASE : `${window.location.origin}${API_BASE}`;
  const token = inviteMutation.data?.token ?? "<token>";
  const cliCommand = `npx artu-teams connect --server ${serverUrl} --token ${token}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(cliCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      pushToast({ tone: "error", title: "Failed to copy to clipboard." });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a machine</DialogTitle>
          <DialogDescription>
            Run the following command on the machine you want to connect.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {inviteMutation.isPending ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating invite...
            </div>
          ) : inviteMutation.isError ? (
            <div className="text-sm text-destructive py-2">
              Failed to create invite. Please try again.
            </div>
          ) : (
            <>
              <div className="relative group">
                <pre className="bg-muted/50 border border-border p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
                  {cliCommand}
                </pre>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Link expires in 24 hours.
              </p>

              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Waiting for connection...
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
