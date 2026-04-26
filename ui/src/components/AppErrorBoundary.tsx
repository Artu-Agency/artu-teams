import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[AppErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-[300px] items-center justify-center p-8">
        <div className="max-w-md space-y-4 text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
          <h2 className="text-lg font-semibold">
            {this.props.fallbackTitle ?? "Something went wrong"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {this.state.error.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
