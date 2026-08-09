import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { renderMarkdownToCli } from "@genesiscz/utils/markdown";
import { FABLE_CONFIG_PATH, type FableConfig, packPaths } from "../lib/config";
import { readStageRuns } from "../lib/manifest";
import type { ConsolidatedPrinciple } from "../lib/stages/consolidate";
import type { Episode } from "../lib/stages/types";

export interface ReportOptions {
    /** Print raw markdown instead of the CLI-rendered version. */
    md?: boolean;
    json?: boolean;
}

interface MinedRecord {
    session: string;
    stem: string;
    model: string;
    runId: string;
    minedAt: string;
    episodes: number;
    principles: number;
    extractorFailures: number;
    secs: number;
}

interface FilterRunRecord {
    runId: string;
    slug: string;
    at: string;
    total: number;
    kept: number;
    noHeadroom: number;
    refUnrecoverable: number;
    infraFail: number;
    judgeMissing: number;
}

interface EvalRunRecord {
    runId: string;
    at: string;
    models: { eval: string; judge: string };
    requested?: number;
    warnings?: string[];
    bare: { n: number; meanSoft: number; hardRate: number };
    withSkill: { n: number; meanSoft: number; hardRate: number };
    perEpisode: {
        id: string;
        taskType: string;
        bareSoft?: number;
        skillSoft?: number;
        bareVerdict?: string;
        skillVerdict?: string;
    }[];
}

function readJsonl<T>(path: string): T[] {
    if (!existsSync(path)) {
        return [];
    }

    const records: T[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            records.push(SafeJSON.parse(line, { strict: true }) as T);
        } catch (err) {
            // report is read-only over append-only files; skip torn lines
            logger.debug({ err, path }, "learn-from-fable report: skipped unparseable line");
        }
    }

    return records;
}

function pct(x: number): string {
    return `${(x * 100).toFixed(1)}%`;
}

function code(text: string): string {
    return `\`${text}\``;
}

/** One markdown document covering the entire pipeline state — every run, number, and proof path. */
export function buildReportMarkdown(config: FableConfig): { markdown: string; data: Record<string, unknown> } {
    const paths = packPaths(config);
    const runs = readStageRuns(config);
    const mined = readJsonl<MinedRecord>(join(paths.metaDir, "mined.jsonl"));
    const filterRuns = readJsonl<FilterRunRecord>(join(paths.metaDir, "filter-runs.jsonl"));
    const evalRuns = readJsonl<EvalRunRecord>(join(paths.metaDir, "eval-runs.jsonl"));
    const consolidated = readJsonl<ConsolidatedPrinciple>(join(paths.principlesDir, "consolidated.jsonl"));

    const episodeFiles = existsSync(paths.episodesDir)
        ? readdirSync(paths.episodesDir)
              .filter((name) => name.endsWith(".jsonl"))
              .sort()
        : [];
    const votedArchives = existsSync(paths.principlesDir)
        ? readdirSync(paths.principlesDir)
              .filter((name) => name.includes(".voted."))
              .sort()
        : [];

    const lines: string[] = [];
    const push = (line = "") => lines.push(line);

    push(`# Learn-from-Fable — full pipeline report`);
    push();
    push(`Generated ${new Date().toISOString()} from append-only artifacts under ${code(paths.metaDir)}.`);
    push();

    push(`## Config`);
    push();
    push(`- config file: ${code(FABLE_CONFIG_PATH)}`);
    push(`- pack repo: ${code(config.packPath)}`);
    push(`- sessions mirror: ${code(config.sessionsMirrorPath ?? "—")}`);
    for (const [stage, model] of Object.entries(config.models ?? {})) {
        push(`- model.${stage}: ${code(String(model))}`);
    }

    push();
    push(`## Mined sessions (${mined.length} model×session runs)`);
    push();
    push(`| session | miner model | episodes | principles | fails | secs | run id |`);
    push(`|---|---|---|---|---|---|---|`);
    for (const m of mined) {
        push(
            `| ${code(m.stem.slice(0, 8))} | ${m.model} | ${m.episodes} | ${m.principles} | ${m.extractorFailures} | ${m.secs} | ${code(m.runId)} |`
        );
    }

    push();
    push(`Full session transcript paths:`);
    push();
    for (const m of [...new Map(mined.map((r) => [r.session, r])).values()]) {
        push(`- ${code(m.session)}`);
    }

    push();
    push(`## Episode artifacts (per-model, side by side)`);
    push();
    for (const name of episodeFiles) {
        const filePath = join(paths.episodesDir, name);
        const episodes = readJsonl<Episode>(filePath);
        push(`### ${code(name)} — ${episodes.length} episodes`);
        push();
        push(`Path: ${code(filePath)}`);
        push();
        for (const ep of episodes) {
            const scores =
                ep.naiveScore != null || ep.referenceScore != null
                    ? ` (naive ${ep.naiveScore ?? "—"} / ref ${ep.referenceScore ?? "—"})`
                    : "";
            push(`- ${code(ep.id)} [${ep.taskType}] mined by ${ep.minedBy}${scores}`);
        }

        push();
    }

    push(`## Filter runs (contrastive: keep iff reference recoverable AND bare model has headroom)`);
    push();
    if (filterRuns.length === 0) {
        push(`_none recorded_`);
    } else {
        push(`| run id | episode slug | total | kept | no-headroom | ref-unrecoverable | infra-fail | judge-missing |`);
        push(`|---|---|---|---|---|---|---|---|`);
        for (const f of filterRuns) {
            push(
                `| ${code(f.runId)} | ${f.slug} | ${f.total} | **${f.kept}** | ${f.noHeadroom} | ${f.refUnrecoverable} | ${f.infraFail} | ${f.judgeMissing} |`
            );
        }
    }

    push();
    push(`## Consolidation (multi-model useful/useless votes)`);
    push();
    push(`Survivors: **${consolidated.length}** → ${code(join(paths.principlesDir, "consolidated.jsonl"))}`);
    if (votedArchives.length) {
        push(`Archived vote inputs: ${votedArchives.map((name) => code(join(paths.principlesDir, name))).join(", ")}`);
    }

    push();
    for (const p of consolidated) {
        push(`- **${p.principle}**`);
        push(`  - why: ${p.why}`);
        push(
            `  - from session ${code(p.sessionStem.slice(0, 8))}, mined by ${p.minedBy}, final confidence ${pct(p.finalConfidence / 100)}`
        );
        for (const v of p.votes) {
            push(
                `  - vote r${v.round} ${v.model}: ${v.useful ? "useful" : "useless"} @${v.confidence}%${v.duplicateOf != null ? ` dup-of #${v.duplicateOf}` : ""}${v.note ? ` — ${v.note}` : ""}`
            );
        }
    }

    push();
    push(`## A/B eval runs (bare vs +fable-style skill, judged against Fable reference)`);
    push();
    for (const run of evalRuns) {
        push(`### ${code(run.runId)} (${run.at})`);
        push();
        push(`- eval model: ${code(run.models.eval)} · judge: ${code(run.models.judge)}`);
        push(
            `- **bare**: n=${run.bare.n}, meanSoft=${run.bare.meanSoft}, hardRate=${run.bare.hardRate} · ` +
                `**+skill**: n=${run.withSkill.n}, meanSoft=${run.withSkill.meanSoft}, hardRate=${run.withSkill.hardRate}`
        );
        if (run.requested != null) {
            push(`- episodes requested: ${run.requested}`);
        }

        for (const warning of run.warnings ?? []) {
            push(`- ⚠️ ${warning}`);
        }

        push();
        push(`| episode | task | bare soft | skill soft | bare verdict | skill verdict |`);
        push(`|---|---|---|---|---|---|`);
        for (const e of run.perEpisode) {
            push(
                `| ${code(e.id)} | ${e.taskType} | ${e.bareSoft ?? "—"} | ${e.skillSoft ?? "—"} | ${e.bareVerdict ?? "—"} | ${e.skillVerdict ?? "—"} |`
            );
        }

        push();
    }

    push(`## Stage-run audit trail (${runs.length} runs)`);
    push();
    push(`Source: ${code(paths.stageRunsPath)} — every run with params, inputs, outputs, and full errors.`);
    push();
    push(`| run id | stage | status | model(s) | started | secs |`);
    push(`|---|---|---|---|---|---|`);
    for (const r of runs) {
        const secs =
            r.finishedAt && r.startedAt
                ? ((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(1)
                : "—";
        const model = Array.isArray(r.model) ? r.model.join(", ") : (r.model ?? "—");
        push(`| ${code(r.id)} | ${r.stage} | ${r.status} | ${model} | ${r.startedAt} | ${secs} |`);
    }

    push();
    push(`## Where to verify every model call`);
    push();
    push(
        `- per-request tokens + write-time cost: ${code(join(env.tools.getHome(), ".genesis-tools/ai-proxy/usage/requests.jsonl"))} (proxy records every call; grep by model id)`
    );
    push(
        `- day-stamped debug logs (full prompts on jsonrepair events, drift retries): ${code(join(env.tools.getHome(), ".genesis-tools/logs/"))}`
    );
    push(`- episode inputs (context prefixes fed to models) + reference outputs: the per-model episode files above`);
    push(
        `- eval judge verdict texts: ${code(join(paths.metaDir, "eval-runs.jsonl"))} (perEpisode[].bareVerdict/skillVerdict)`
    );
    push(
        `- pack outputs: spec ${code(paths.spec)} · golden traces ${code(paths.goldenTraces)} · skill ${code(join(paths.skillDir, "SKILL.md"))}`
    );

    return {
        markdown: lines.join("\n"),
        data: { runs, mined, filterRuns, evalRuns, consolidated, episodeFiles, votedArchives },
    };
}

export function reportCommand(config: FableConfig, options: ReportOptions): void {
    const { markdown, data } = buildReportMarkdown(config);

    if (options.json) {
        out.result(data);
        return;
    }

    if (options.md) {
        out.print(markdown);
        return;
    }

    out.print(renderMarkdownToCli(markdown));
}
