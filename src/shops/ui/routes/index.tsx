import { getSettingsRepository } from "@app/shops/lib/settings";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
    beforeLoad: async () => {
        let target = "/watchlist";
        try {
            const settings = await getSettingsRepository().read();
            target = settings.default_landing_view;
        } catch {
            // Fresh install or unreadable file — fall back to spec default.
        }

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
