import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { workApi } from "@genesiscz/utils/work/api";

/** The global `work`: each method of `workApi` takes its params object and answers the `Reply` object. */
export class WorkToolset extends ReplToolset {
    readonly api = workApi;

    async bootstrap(): Promise<Record<string, unknown>> {
        // lazy: listing the toolsets loads no store, no git and no T3 lookup
        // lint-rules-ignore: the REPL global work uses the shared TypeScript door (spec P2)
        const { callWorkHere } = await import("@app/work/doors/service");
        const work: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {};

        for (const method of workApi.methods) {
            work[method.name] = (params = {}) => callWorkHere(method.name, params);
        }

        return { work };
    }
}
