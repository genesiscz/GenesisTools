import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
    error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("youtube ui error", error, info.componentStack);
    }

    render() {
        if (!this.state.error) {
            return this.props.children;
        }

        return (
            <Card className="yt-panel border-destructive/40">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-destructive">
                        <AlertTriangle className="size-5" />
                        Interface fault detected
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <pre className="overflow-auto rounded-xl border border-destructive/20 bg-black/35 p-4 text-xs text-muted-foreground">
                        {this.state.error.message}
                    </pre>
                    <Button onClick={() => this.setState({ error: null })}>Retry</Button>
                </CardContent>
            </Card>
        );
    }
}
