import type { ApiDescriptor } from "@genesiscz/utils/api-descriptor";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { workApi } from "@genesiscz/utils/work/api";
import { callOptionsOf, withoutCallOptions, workCallEnvelope } from "@genesiscz/utils/work/door";
import { z } from "zod";

/**
 * `workApi` with the call options of the MCP tools beside each write's params: the REPL boundary keeps only the keys a
 * schema names, and `describe("work.finish")` shows them in the signature.
 */
const replWorkApi: ApiDescriptor = {
    ...workApi,
    methods: workApi.methods.map((method) =>
        method.effect !== "read" && method.params instanceof z.ZodObject
            ? { ...method, params: method.params.extend(workCallEnvelope.shape) }
            : method
    ),
    notes: [
        ...workApi.notes,
        'A write also takes the MCP tools\' call options beside its params: requestId, dryRun, ownerSaid and override (why this session does a write that a role rule refuses; the journal keeps it), as in work.finish({ ref, proof, override: "the owner asked me to close it" }).',
    ],
};

/** The global `work`: each method of `workApi` takes its params object and answers the `Reply` object. */
export class WorkToolset extends ReplToolset {
    readonly api = replWorkApi;

    async bootstrap(): Promise<Record<string, unknown>> {
        // lazy: listing the toolsets loads no store, no git and no T3 lookup
        // lint-rules-ignore: the REPL global work uses the shared TypeScript door (spec P2)
        const { callWorkHere } = await import("@app/work/doors/service");
        const work: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {};

        for (const method of workApi.methods) {
            work[method.name] = (params = {}) =>
                callWorkHere(method.name, withoutCallOptions(params), callOptionsOf(params));
        }

        return { work };
    }
}
