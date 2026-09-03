import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

interface ErrorBoundaryProps {
    children: ReactNode;
}

interface ErrorBoundaryState {
    error: Error | null;
}

/**
 * Top-level render error boundary. Catches errors thrown during render of the subtree,
 * logs them (so a crash leaves a trace), and shows a retry affordance that clears the
 * error and re-mounts the children. Wraps the app under the providers in the root layout.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // No swallowed errors — surface to the JS console / RN red-box pipeline with context.
        console.error("[ErrorBoundary] render error", error, info.componentStack);
    }

    private readonly reset = (): void => {
        this.setState({ error: null });
    };

    render(): ReactNode {
        const { error } = this.state;

        if (!error) {
            return this.props.children;
        }

        return (
            <View
                testID="error-boundary"
                accessibilityLabel="error-boundary"
                className="flex-1 items-center justify-center gap-4 bg-dd-bg-base p-6"
            >
                <Text className="text-lg font-semibold text-dd-danger">Something went wrong</Text>
                <Text selectable className="text-center text-xs text-dd-text-muted">
                    {error.message}
                </Text>
                <Pressable
                    testID="error-boundary-retry"
                    accessibilityLabel="error-boundary-retry"
                    onPress={this.reset}
                    className="rounded-xl border border-dd-border bg-dd-bg-panel px-4 py-2"
                >
                    <Text className="text-sm text-dd-text-primary">Retry</Text>
                </Pressable>
            </View>
        );
    }
}
