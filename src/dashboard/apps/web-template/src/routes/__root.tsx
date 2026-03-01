import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { TRPCRouter } from "@/integrations/trpc/router";
import Header from "../components/Header";
import ConvexProvider from "../integrations/convex/provider";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import WorkOSProvider from "../integrations/workos/provider";
import AiDevtools from "../lib/ai-devtools";
import StoreDevtools from "../lib/demo-store-devtools";
import appCss from "../styles.css?url";

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
                    <ConvexProvider>
                        <Header />
                        {children}
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
                                StoreDevtools,
                                AiDevtools,
                            ]}
                        />
                    </ConvexProvider>
                </WorkOSProvider>
                <Scripts />
            </body>
        </html>
    );
}
