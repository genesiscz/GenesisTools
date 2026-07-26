import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";
import type { FableConfig } from "../lib/config";
import { listCandidates, loadMinedState, sessionMeta, unminedCandidates } from "../lib/enumerate";

export interface ListOptions {
    limit: number;
    minSize: number;
    all?: boolean;
    details?: boolean;
    json?: boolean;
}

function ageDays(mtimeMs: number): string {
    const days = (Date.now() - mtimeMs) / 86_400_000;
    return days >= 1 ? `${Math.floor(days)}d` : `${Math.floor(days * 24)}h`;
}

export async function listCommand(config: FableConfig, options: ListOptions): Promise<void> {
    const candidates = await listCandidates(config, { minSize: options.minSize });
    const mined = loadMinedState(config);
    const pool = options.all ? candidates : unminedCandidates(candidates, mined);
    const rows = pool.slice(0, options.limit);

    const detailed = await Promise.all(
        rows.map(async (c) => ({
            ...c,
            meta: options.details || options.json ? await sessionMeta(c.path) : undefined,
            mined: mined.all.has(c.stem),
        }))
    );

    if (options.json) {
        out.result({ total: pool.length, shown: detailed.length, sessions: detailed });
        return;
    }

    renderCliHeader(
        options.all ? "Fable sessions (all candidates)" : "Fable sessions (unmined queue)",
        `${pool.length} total · oldest first · showing ${detailed.length}`
    );

    const headers = options.details
        ? ["#", "STEM", "AGE", "SIZE", "PROJECT", "BRANCH", "SRC", "FIRST PROMPT"]
        : ["#", "STEM", "AGE", "SIZE", "PROJECT", "SRC"];
    const table = createBoxTable(headers);

    detailed.forEach((c, i) => {
        const base = [
            pc.dim(String(i + 1)),
            pc.white(c.stem.slice(0, 8)),
            pc.white(ageDays(c.mtimeMs)),
            pc.white(formatBytes(c.size)),
            pc.cyan(truncateDisplay(c.project, 28)),
        ];

        if (options.details) {
            table.push([
                ...base,
                pc.white(truncateDisplay(c.meta?.gitBranch ?? "", 20)),
                c.source === "live" ? pc.green("live") : pc.yellow("mirr"),
                pc.dim(truncateDisplay(c.meta?.firstUserPrompt ?? "", 48)),
            ]);
        } else {
            table.push([...base, c.source === "live" ? pc.green("live") : pc.yellow("mirr")]);
        }
    });

    out.println(table.toString());
    out.log.info(`Pipe into mining: tools learn-from-fable select --limit ${options.limit}`);
}
