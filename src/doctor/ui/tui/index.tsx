import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { PlainRunOpts } from "@app/doctor/ui/plain";
import { App } from "./App";

export async function runTui(opts: PlainRunOpts): Promise<void> {
    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    const selectedAnalyzers = opts.only
        ? opts.analyzers.filter((analyzer) => opts.only?.includes(analyzer.id))
        : opts.analyzers;

    try {
        await render(
            () => (
                <App
                    analyzers={selectedAnalyzers}
                    runId={opts.runId}
                    dryRun={opts.dryRun}
                    thorough={opts.thorough}
                    fresh={opts.fresh}
                />
            ),
            renderer
        );
        await new Promise<void>((resolve) => {
            renderer.on("destroy", () => resolve());
        });
    } finally {
        renderer.destroy();
    }
}
