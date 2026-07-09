import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { probeCooccurrence } from "@app/utils/string";
import { cachedPackument, ensureBeautified, ensureBundle, ensureNormalized } from "../lib/bundle";
import { filterByPatterns, splitChunks } from "../lib/chunks";
import { resolveRange } from "../lib/registry";

export interface BisectOptions {
    pattern: string[];
    mode: string;
    windowBefore: string;
    windowAfter: string;
    platform?: string;
    json: boolean;
}

interface VersionState {
    version: string;
    published: string | null;
    state: string;
}

export async function bisectCommand(from: string, to: string, opts: BisectOptions): Promise<void> {
    const packument = await cachedPackument({});
    const versions = resolveRange({ all: packument.versions, from, to });

    if (opts.mode === "probe" && opts.pattern.length < 2) {
        throw new Error(
            "probe mode needs ≥2 --pattern (anchor + co-occurring); for a single pattern use --mode chunks"
        );
    }

    const states: VersionState[] = [];

    for (const version of versions) {
        const ref = await ensureBundle({ version, platform: opts.platform });
        let state: string;

        if (opts.mode === "probe") {
            const [primary, ...rest] = opts.pattern;
            const source = await Bun.file(ref.entrypointPath).text();
            const result = probeCooccurrence({
                source,
                primary: new RegExp(primary ?? ""),
                secondary: rest.map((p) => new RegExp(p)),
                before: Number.parseInt(opts.windowBefore, 10),
                after: Number.parseInt(opts.windowAfter, 10),
            });
            state = result.matched ? "PRESENT" : "absent";
        } else {
            const [beau, norm] = [await ensureBeautified(ref), await ensureNormalized(ref)];
            const matching = filterByPatterns(
                splitChunks(norm, beau),
                opts.pattern.map((p) => new RegExp(p))
            );
            state = matching
                .map((c) => c.hash)
                .sort()
                .join(",");
        }

        states.push({ version, published: packument.time[version] ?? null, state });
        logger.info(
            `${version}: ${opts.mode === "probe" ? state : `${state.split(",").filter((s) => s.length > 0).length} matching chunks`}`
        );
    }

    const transitions: Array<{ before: VersionState; after: VersionState }> = [];

    for (let i = 1; i < states.length; i++) {
        const prev = states[i - 1];
        const cur = states[i];

        if (prev !== undefined && cur !== undefined && prev.state !== cur.state) {
            transitions.push({ before: prev, after: cur });
        }
    }

    if (opts.json) {
        out.result(SafeJSON.stringify({ versions: states, transitions }) ?? "{}");
        return;
    }

    for (const s of states) {
        const display =
            opts.mode === "probe"
                ? s.state
                : `chunks:${s.state === "" ? 0 : s.state.split(",").length}#${String(Bun.hash(s.state)).slice(0, 8)}`;
        out.println(`${s.version}\t${s.published?.slice(0, 10) ?? "?"}\t${display}`);
    }

    if (transitions.length === 0) {
        out.println("\nNo transition found in range.");
    }

    for (const t of transitions) {
        out.println(
            `\nTransition: ${t.before.version} → ${t.after.version} (published ${t.before.published?.slice(0, 10)} → ${t.after.published?.slice(0, 10)})`
        );
        out.println(
            `Inspect: tools claude-code diff ${t.before.version} ${t.after.version} --pattern ${opts.pattern.map((p) => `'${p}'`).join(" ")}`
        );
    }
}
