import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { PlainRunOpts } from "@app/doctor/ui/plain";
import { setBackend } from "@app/utils/prompts/p";
import { opentuiBackend } from "@app/utils/prompts/p/opentui-backend";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

export async function runTui(opts: PlainRunOpts): Promise<void> {
    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    setBackend(opentuiBackend(renderer));

    const shutdown = (): void => {
        renderer.destroy();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const selectedAnalyzers = opts.only
        ? opts.analyzers.filter((analyzer) => opts.only?.includes(analyzer.id))
        : opts.analyzers;

    try {
        await render(
            () => (
                <ErrorBoundary>
                    <App
                        analyzers={selectedAnalyzers}
                        runId={opts.runId}
                        dryRun={opts.dryRun}
                        thorough={opts.thorough}
                        fresh={opts.fresh}
                    />
                </ErrorBoundary>
            ),
            renderer
        );
        await new Promise<void>((resolve) => {
            renderer.on("destroy", () => resolve());
        });
    } finally {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        renderer.destroy();
    }
}
