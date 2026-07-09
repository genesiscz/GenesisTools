import { out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { cachedPackument } from "../lib/bundle";
import { resolveRange } from "../lib/registry";

export interface VersionsOptions {
    from?: string;
    to?: string;
    json: boolean;
    force: boolean;
}

export async function versionsCommand(opts: VersionsOptions): Promise<void> {
    const packument = await cachedPackument({ force: opts.force });

    if ((opts.from === undefined) !== (opts.to === undefined)) {
        throw new Error("--from and --to must be provided together");
    }

    const versions =
        opts.from !== undefined && opts.to !== undefined
            ? resolveRange({ all: packument.versions, from: opts.from, to: opts.to })
            : packument.versions;

    if (opts.json) {
        out.result(
            SafeJSON.stringify(versions.map((v) => ({ version: v, published: packument.time[v] ?? null }))) ?? "[]"
        );
        return;
    }

    for (const v of versions) {
        out.println(`${v}\t${packument.time[v] ?? "?"}`);
    }
}
