import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
    head: () => ({
        title: "GenesisTools - REAS Analyzer",
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { name: "theme-color", content: "#050508" },
            { name: "description", content: "REAS Real Estate Analyzer Dashboard" },
        ],
        links: [{ rel: "stylesheet", href: appCss }],
    }),
    shellComponent: RootDocument,
    component: RootComponent,
});

function RootDocument({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body>
                {children}
                <Scripts />
            </body>
        </html>
    );
}

function RootComponent() {
    return <Outlet />;
}
