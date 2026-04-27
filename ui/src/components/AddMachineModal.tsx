import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useToastActions } from "../context/ToastContext";
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

const CLI_COMMAND = "npx artu-teams connect";

export function AddMachineModal({ open, onOpenChange }: AddMachineModalProps) {
  const { pushToast } = useToastActions();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(CLI_COMMAND);
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
          <div className="relative group">
            <pre className="bg-muted/50 border border-border p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
              {CLI_COMMAND}
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
            A browser window will open for authentication. No token required.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
