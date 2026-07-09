import { logger, out } from "@app/logger";
import { renderUnifiedDiff } from "@app/utils/diff";
import { ensureBeautified, ensureBundle, ensureNormalized } from "../lib/bundle";
import { chunkSetDiff, filterByPatterns, pairChunks, splitChunks } from "../lib/chunks";

export interface DiffOptions {
    pattern?: string[];
    mode: string;
    context: string;
    maxChunks: string;
    platform?: string;
    output?: string;
}

function parseNonNegativeInt(value: string, flag: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${flag} must be a non-negative integer, got "${value}"`);
    }

    return Number.parseInt(value, 10);
}

export async function diffCommand(v1: string, v2: string, opts: DiffOptions): Promise<void> {
    const [refA, refB] = await Promise.all([
        ensureBundle({ version: v1, platform: opts.platform }),
        ensureBundle({ version: v2, platform: opts.platform }),
    ]);
    const context = parseNonNegativeInt(opts.context, "--context");
    let output: string;

    if (opts.mode === "raw" || opts.mode === "normalized") {
        logger.warn(
            `${opts.mode} mode diffs the whole 400K-line files — expect noise; chunks mode is the default for a reason`
        );
        const [a, b] =
            opts.mode === "raw"
                ? await Promise.all([ensureBeautified(refA), ensureBeautified(refB)])
                : await Promise.all([ensureNormalized(refA), ensureNormalized(refB)]);
        output = renderUnifiedDiff({ before: a, after: b, label: `claude-code-${v1}..${v2}.js`, context });
    } else {
        const [beauA, beauB] = await Promise.all([ensureBeautified(refA), ensureBeautified(refB)]);
        const [normA, normB] = await Promise.all([ensureNormalized(refA), ensureNormalized(refB)]);
        const chunksA = splitChunks(normA, beauA);
        const chunksB = splitChunks(normB, beauB);
        const d = chunkSetDiff(chunksA, chunksB);
        const patterns = (opts.pattern ?? []).map((p) => new RegExp(p));
        const onlyA = patterns.length > 0 ? filterByPatterns(d.onlyA, patterns) : d.onlyA;
        const onlyB = patterns.length > 0 ? filterByPatterns(d.onlyB, patterns) : d.onlyB;
        const pairs = pairChunks(onlyA, onlyB);
        const cap =
            patterns.length > 0 ? Number.POSITIVE_INFINITY : parseNonNegativeInt(opts.maxChunks, "--max-chunks");
        const header = [
            `# claude-code ${v1} → ${v2} (chunks mode${patterns.length > 0 ? `, patterns: ${patterns.map(String).join(" ")}` : ""})`,
            `# identical chunks: ${d.sameCount}, changed: ${d.onlyA.length} → ${d.onlyB.length}${patterns.length > 0 ? `, matching patterns: ${onlyA.length} → ${onlyB.length}` : ""}`,
            pairs.length > cap ? `# showing first ${cap} of ${pairs.length} pairs — narrow with --pattern` : "",
        ].filter((l) => l.length > 0);
        const rendered = pairs.slice(0, cap === Number.POSITIVE_INFINITY ? undefined : cap).map((p) => {
            const label = `chunk@${p.a?.startLine ?? "-"}..${p.b?.startLine ?? "-"} (similarity ${p.similarity.toFixed(2)})`;
            return renderUnifiedDiff({ before: p.a?.display ?? "", after: p.b?.display ?? "", label, context });
        });
        output = [...header, "", ...rendered].join("\n");
    }

    if (opts.output !== undefined) {
        await Bun.write(opts.output, output);
        out.log.success(`diff written to ${opts.output}`);
    } else {
        out.println(output);
    }
}
