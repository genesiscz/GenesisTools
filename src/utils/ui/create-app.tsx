import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ComponentType } from "react";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toaster } from "sonner";

export interface DashboardAppConfig {
    /** The root React component (typically a Router) */
    App: ComponentType;
    /** Root element ID (default: "root") */
    rootId?: string;
    /** Custom QueryClient instance (default: creates new one) */
    queryClient?: QueryClient;
    /** Toaster props override (default: dark theme) */
    toaster?: ComponentProps<typeof Toaster>;
}

const rootCache = new WeakMap<Element, Root>();

export function createDashboardApp(config: DashboardAppConfig) {
    const queryClient = config.queryClient ?? new QueryClient();
    const rootElement = document.getElementById(config.rootId ?? "root");

    if (!rootElement) {
        throw new Error(`Root element #${config.rootId ?? "root"} not found`);
    }

    let root = rootCache.get(rootElement);

    if (!root) {
        root = createRoot(rootElement);
        rootCache.set(rootElement, root);
    }

    root.render(
        <StrictMode>
            <QueryClientProvider client={queryClient}>
                <config.App />
                <Toaster theme="dark" {...config.toaster} />
            </QueryClientProvider>
        </StrictMode>
    );
}
