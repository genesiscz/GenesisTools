import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { Toaster } from "sonner";
import TanStackQueryDevtools from "@/integrations/tanstack-query/devtools";
import type { TRPCRouter } from "@/integrations/trpc/router";
import WorkOSProvider from "@/integrations/workos/provider";
import AiDevtools from "@/lib/ai-example/ai-devtools";
import appCss from "@/styles.css?url";

interface MyRouterContext {
    queryClient: QueryClient;

    trpc: TRPCOptionsProxy<TRPCRouter>;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    head: () => ({
        meta: [
            {
                charSet: "utf-8",
            },
            {
                name: "viewport",
                content: "width=device-width, initial-scale=1",
            },
            {
                title: "TanStack Start Starter",
            },
        ],
        links: [
            {
                rel: "stylesheet",
                href: appCss,
            },
        ],
    }),

    shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body>
                <WorkOSProvider>
                    {children}
                    <Toaster
                        theme="dark"
                        position="bottom-right"
                        toastOptions={{
                            style: {
                                background: "rgba(3, 3, 8, 0.95)",
                                border: "1px solid rgba(245, 158, 11, 0.2)",
                                color: "#fff",
                            },
                        }}
                    />
                    {import.meta.env.DEV && (
                        <TanStackDevtools
                            config={{
                                position: "bottom-right",
                            }}
                            plugins={[
                                {
                                    name: "Tanstack Router",
                                    render: <TanStackRouterDevtoolsPanel />,
                                },
                                TanStackQueryDevtools,
                                AiDevtools,
                            ]}
                        />
                    )}
                </WorkOSProvider>
                <Scripts />
            </body>
        </html>
    );
}
