import { existsSync } from "node:fs";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus, renderCliHeader, renderCliSection } from "@genesiscz/utils/table";
import pc from "picocolors";
import { FABLE_CONFIG_PATH, type FableConfig, packPaths } from "../lib/config";
import { listCandidates, loadMinedState, unminedCandidates } from "../lib/enumerate";
import { readStageRuns } from "../lib/manifest";
import { STAGES } from "../lib/stages/registry";

export interface StatsOptions {
    minSize: number;
    json?: boolean;
}

export async function statsCommand(config: FableConfig, options: StatsOptions): Promise<void> {
    const paths = packPaths(config);
    const candidates = await listCandidates(config, { minSize: options.minSize });
    const mined = loadMinedState(config);
    const unmined = unminedCandidates(candidates, mined);
    const runs = readStageRuns(config);

    const lastProse = [...mined.prose.entries()].at(-1);
    const byProject = new Map<string, number>();
    for (const c of unmined) {
        byProject.set(c.project, (byProject.get(c.project) ?? 0) + 1);
    }

    if (options.json) {
        out.result({
            config: { path: FABLE_CONFIG_PATH, packPath: config.packPath },
            candidates: candidates.length,
            mined: { prose: mined.prose.size, episodes: mined.episodes.size, union: mined.all.size },
            unmined: unmined.length,
            lastProseMined: lastProse ? { stem: lastProse[0], ...lastProse[1] } : null,
            oldestUnmined: unmined[0]?.path ?? null,
            unminedByProject: Object.fromEntries([...byProject.entries()].sort((a, b) => b[1] - a[1])),
            stageRuns: runs.length,
        });
        return;
    }

    renderCliHeader("Learn From Fable", "pack state + mining census");

    const table = createBoxTable(["WHAT", "VALUE"]);
    table.push(
        ["pack repo", pc.white(config.packPath)],
        [
            "spec",
            formatDotStatus(existsSync(paths.spec) ? "ok" : "err", existsSync(paths.spec) ? "present" : "missing"),
        ],
        ["candidates (≥minSize, deduped)", pc.white(String(candidates.length))],
        ["mined — prose miner", pc.white(String(mined.prose.size))],
        ["mined — episode miner (skillopt)", pc.white(String(mined.episodes.size))],
        ["mined — union", pc.white(String(mined.all.size))],
        ["UNMINED", pc.bold(pc.yellow(String(unmined.length)))],
        [
            "last prose-mined",
            lastProse ? pc.white(`${lastProse[0].slice(0, 8)}… (${lastProse[1].minedAt ?? "?"})`) : pc.dim("never"),
        ],
        ["stage runs recorded", pc.white(String(runs.length))]
    );
    out.println(table.toString());

    if (unmined.length) {
        renderCliSection("Unmined by project (oldest-first queue)");
        const pt = createBoxTable(["PROJECT", "UNMINED"]);
        for (const [project, count] of [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
            pt.push([pc.white(project), pc.white(String(count))]);
        }

        out.println(pt.toString());
    }

    renderCliSection("Stages");
    const st = createBoxTable(["STAGE", "STATUS", "WHAT"]);
    for (const s of STAGES) {
        st.push([
            pc.white(s.name),
            formatDotStatus(s.status === "ready" ? "ok" : "dim", s.status),
            pc.dim(s.description.length > 76 ? `${s.description.slice(0, 73)}…` : s.description),
        ]);
    }

    out.println(st.toString());
    out.log.info(
        `Next: ${STAGES.find((s) => s.status === "ready" && s.name === "list")?.example ?? ""} · then mine (planned)`
    );
}
