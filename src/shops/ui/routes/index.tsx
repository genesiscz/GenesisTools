import { getSettingsRepository } from "@app/shops/lib/settings";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const getDefaultLanding = createServerFn({ method: "GET" }).handler(async () => {
    try {
        const settings = await getSettingsRepository().read();
        return settings.default_landing_view;
    } catch {
        return "/watchlist";
    }
});

export const Route = createFileRoute("/")({
    beforeLoad: async () => {
        const target = await getDefaultLanding();

        if (target !== "/") {
            throw redirect({ to: target });
        }
    },
    component: IndexPage,
});

function IndexPage() {
    return (
        <div className="max-w-6xl mx-auto px-6 py-12 text-center">
            <h1 className="font-mono text-2xl text-foreground tracking-[0.2em] mb-3">SHOPS :: HOME</h1>
            <p className="text-muted-foreground text-sm">
                Open <span className="text-[var(--color-neon-cyan)]">/watchlist</span> for your tracked products,
                <span className="text-[var(--color-neon-amber)]"> /browse</span> to explore the catalog, or change your
                default landing view in
                <a className="ml-1 underline text-[var(--color-neon-cyan)]" href="/settings">
                    settings
                </a>
                .
            </p>
        </div>
    );
}
