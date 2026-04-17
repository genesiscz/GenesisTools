import type { PlainRunOpts } from "@app/doctor/ui/plain";
import { setBackend } from "@app/utils/prompts/p";
import { opentuiBackend } from "@app/utils/prompts/p/opentui-backend";
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import "./views/register";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

export async function runTui(opts: PlainRunOpts): Promise<void> {
    const renderer = await createCliRenderer({ exitOnCtrlC: true });
    setBackend(opentuiBackend(renderer));

    const selectedAnalyzers = opts.only
        ? opts.analyzers.filter((analyzer) => opts.only?.includes(analyzer.id))
        : opts.analyzers;

    const destroyed = new Promise<void>((resolve) => {
        renderer.once("destroy", () => resolve());
    });

    render(
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

    // Workaround for @opentui/core 0.1.100 render-loop stall (issue #789):
    // bursts of requestRender during mount can leave the loop parked with
    // immediateRerenderRequested=true but no next frame scheduled. A low-rate
    // heartbeat wakes it back up.
    const heartbeat = setInterval(() => {
        renderer.requestRender();
    }, 250);
    renderer.once("destroy", () => clearInterval(heartbeat));

    await destroyed;
}
