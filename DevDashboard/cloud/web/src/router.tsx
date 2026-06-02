import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import * as TanstackQuery from "./integrations/tanstack-query/root-provider";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
    const rqContext = TanstackQuery.getContext();

    const router = createRouter({
        routeTree,
        context: {
            ...rqContext,
        },
        defaultPreload: "intent",
        scrollRestoration: true,
    });

    setupRouterSsrQueryIntegration({ router, queryClient: rqContext.queryClient });

    return router;
};

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
