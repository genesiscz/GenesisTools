import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { workApi } from "@genesiscz/utils/work/api";
import type { CallOptions } from "@genesiscz/utils/work/handlers";

/** The global `work`: each method of `workApi` takes its params object and answers the `Reply` object. */
export class WorkToolset extends ReplToolset {
    readonly api = workApi;

    async bootstrap(): Promise<Record<string, unknown>> {
        // lazy: listing the toolsets loads no store, no git and no T3 lookup
        // lint-rules-ignore: the work toolset reaches the store through its session, loaded on bootstrap
        const [{ callWork }, { openSession }] = await Promise.all([
            import("@genesiscz/utils/work/handlers"),
            import("@app/work/session"),
        ]);
        const work: Record<string, (params?: Record<string, unknown>, call?: CallOptions) => Promise<unknown>> = {};

        for (const method of workApi.methods) {
            work[method.name] = async (params = {}, call = {}) => {
                const opened = await openSession(call, { quiet: true });

                try {
                    return await callWork(method.name, params, opened.session);
                } finally {
                    opened.close();
                }
            };
        }

        return { work };
    }
}
