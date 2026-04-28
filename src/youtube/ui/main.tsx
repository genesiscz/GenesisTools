import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        mutations: { retry: 0 },
    },
});

const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}

const root = document.getElementById("root");

if (!root) {
    throw new Error("missing #root element");
}

createRoot(root).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
            <Toaster theme="dark" position="bottom-right" richColors />
        </QueryClientProvider>
    </StrictMode>
);
