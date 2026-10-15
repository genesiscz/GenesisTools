import { createDoctorAnalyzers } from "@app/doctor/analyzers";
import { type ActEvent, runAct } from "@app/doctor/lib/act";
import type { RemoveMethod } from "@app/doctor/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

export interface ActCliOpts {
    analyzer?: string;
    id: string[];
    method?: string;
    yes?: boolean;
    confirm: string[];
    expect: string[];
    expectPaths: string[];
    dryRun?: boolean;
    ndjson?: boolean;
    json?: boolean;
}

export interface ActErrorEnvelope {
    schemaVersion: 1;
    error: { kind: "invalid-call"; message: string };
}

/** Exit 2 with a JSON error on stdout: the call itself is wrong and nothing was touched. */
function invalid(message: string): number {
    const envelope: ActErrorEnvelope = { schemaVersion: 1, error: { kind: "invalid-call", message } };
    out.println(SafeJSON.stringify(envelope, null, 2));
    return 2;
}

export function parseExpect(values: string[]): Map<string, number> | string {
    const expect = new Map<string, number>();

    for (const value of values) {
        const at = value.lastIndexOf("=");
        const bytes = at > 0 ? Number(value.slice(at + 1)) : Number.NaN;

        if (!Number.isFinite(bytes) || bytes < 0) {
            return `--expect takes <findingId>=<bytes>, got "${value}"`;
        }

        expect.set(value.slice(0, at), bytes);
    }

    return expect;
}

export function parseExpectPaths(values: string[]): Map<string, string> | string {
    const expect = new Map<string, string>();

    for (const value of values) {
        const at = value.lastIndexOf("=");
        const hash = at > 0 ? value.slice(at + 1) : "";

        if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
            return `--expect-paths takes <findingId>=sha256:<hex> (the finding's pathsHash), got "${value}"`;
        }

        expect.set(value.slice(0, at), hash);
    }

    return expect;
}

export async function runActCli(actionId: string, opts: ActCliOpts, argv: string[]): Promise<number> {
    if (!opts.analyzer) {
        return invalid("--analyzer <id> is required");
    }

    if (opts.id.length === 0) {
        return invalid("pass at least one --id <findingId>");
    }

    if (opts.method !== undefined && opts.method !== "trash" && opts.method !== "delete") {
        return invalid(`--method takes trash or delete, got "${opts.method}"`);
    }

    const expect = parseExpect(opts.expect);

    if (typeof expect === "string") {
        return invalid(expect);
    }

    const expectPaths = parseExpectPaths(opts.expectPaths);

    if (typeof expectPaths === "string") {
        return invalid(expectPaths);
    }

    const ndjson = Boolean(opts.ndjson);
    const run = await runAct(
        {
            actionId,
            analyzerId: opts.analyzer,
            ids: opts.id,
            ...(opts.method ? { method: opts.method as RemoveMethod } : {}),
            yes: Boolean(opts.yes),
            confirm: opts.confirm,
            expect,
            expectPaths,
            dryRun: Boolean(opts.dryRun),
            argv,
        },
        {
            analyzers: createDoctorAnalyzers(),
            onEvent: (event: ActEvent) => {
                if (ndjson) {
                    out.println(SafeJSON.stringify(event));
                }
            },
        }
    );

    if (!ndjson) {
        out.println(SafeJSON.stringify(run.result, null, 2));
    }

    return run.exitCode;
}
