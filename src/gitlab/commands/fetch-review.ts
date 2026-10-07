/**
 * The receive mode of `gitlab pr <iid> review --receive`: the discussions of one MR as raw JSON (always saved, and the default
 * stdout) and, with `--md`, a per-thread Markdown report rendered through json2md with code
 * excerpts from the local working tree and the reviewer's frozen view.
 *
 * In a terminal it shows clack status lines and a confirm prompt; piped or redirected, it writes
 * plain status to stderr and the result to stdout.
 *
 *   tools gitlab pr <iid> review --receive [--project group/name] [--cwd <checkout>] [--md | --format json|md|both]
 */

import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TargetOptions } from "@app/gitlab/commands/shared";
import { currentUser, type ProjectApi, projectBase, resolveProjectApi, restGetPaginated } from "@app/gitlab/lib/client";
import { FETCH_FORMATS, loadConfig } from "@app/gitlab/lib/config";
import { assignThreadRefs, idMapPath, loadIdMap, saveIdMap } from "@app/gitlab/lib/ids";
import {
    collectUnresolvedAnchorPairs,
    type Discussion,
    expandThreads,
    fetchAnchorViews,
    fetchTipViews,
    receiveIndex,
    renderMarkdown,
    threadStats,
} from "@app/gitlab/lib/review-render";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { formatSchema, type OutputMode } from "@genesiscz/utils/json-schema";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";

const FORMATS = FETCH_FORMATS;
const SCHEMA_FORMATS = ["schema", "skeleton", "typescript", "none"] as const;

export interface FetchReviewOptions extends TargetOptions {
    llm?: boolean;
    expand?: string;
    cwd?: string;
    out?: string;
    format?: string;
    md?: boolean;
    contextLines?: string;
    confirm?: boolean;
    anchors?: boolean;
    schemaFormat?: string;
    schemaSidecar?: boolean;
    mdSidecar?: boolean;
}

function isTty(): boolean {
    return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

const status = {
    info: (msg: string) => (isTty() ? out.log.info(msg) : out.printlnErr(`ℹ  ${msg}`)),
    success: (msg: string) => (isTty() ? out.log.success(msg) : out.printlnErr(`✓  ${msg}`)),
    warn: (msg: string) => (isTty() ? out.log.warn(msg) : out.printlnErr(`⚠  ${msg}`)),
    message: (msg: string) => (isTty() ? out.log.message(msg) : out.printlnErr(msg)),
};

/** Review ids for the MR's threads, from its stored map (new threads get new ids, the map is saved). */
async function threadRefs(api: ProjectApi, iid: string, discussions: Discussion[]): Promise<Map<string, string>> {
    const me = await currentUser(api);
    const path = idMapPath({ host: api.host, project: api.project, iid: Number(iid) });
    const map = loadIdMap(path);
    const threads = discussions
        .filter((d) => !d.individual_note && d.id)
        .map((d) => ({ id: d.id ?? "", author: d.notes?.[0]?.author?.username ?? "" }));
    const refs = assignThreadRefs(map, threads, me.username);
    saveIdMap(path, map);

    return refs;
}

export async function runFetchReview(mrIid: string, opts: FetchReviewOptions): Promise<void> {
    const tty = isTty();
    if (tty) {
        out.intro(`gitlab pr ${mrIid} review --receive`);
    }

    if (!/^\d+$/.test(mrIid)) {
        throw new Error(`MR_IID must be a positive integer; got "${mrIid}".`);
    }

    if (opts.md && opts.format && opts.format !== "md") {
        throw new Error(`--md conflicts with --format ${opts.format}; pass one of them.`);
    }

    const config = await loadConfig();
    const format = opts.md ? "md" : (opts.format ?? config.review.fetch.format);
    if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
        throw new Error(`Invalid --format ${format}; expected ${FORMATS.join(" | ")}`);
    }

    const schemaFormat = opts.schemaFormat ?? "none";
    if (!SCHEMA_FORMATS.includes(schemaFormat as (typeof SCHEMA_FORMATS)[number])) {
        throw new Error(`Invalid --schema-format ${schemaFormat}; expected ${SCHEMA_FORMATS.join(" | ")}`);
    }

    // `|| 3` turned an explicit `--context-lines 0` into 3; only an unparseable value falls back.
    const fallbackContext = config.review.fetch.contextLines;
    const parsedContext = Number.parseInt(opts.contextLines ?? String(fallbackContext), 10);
    const contextLines = Number.isNaN(parsedContext) ? fallbackContext : Math.max(0, parsedContext);
    const cwd = resolve(opts.cwd ?? process.cwd());
    if (!existsSync(cwd)) {
        throw new Error(`--cwd ${cwd} does not exist`);
    }

    const api = await resolveProjectApi({ host: opts.host, project: opts.project, cwd });
    if (!opts.project) {
        status.info(`Project: ${api.project} on ${api.host}`);
    }

    const outPath = opts.out ?? join(tmpdir(), `gitlab-review-${mrIid}.json`);

    if (tty && opts.confirm !== false) {
        const ok = await p.confirm({
            message: `Fetch discussions for ${api.project} MR !${mrIid} → ${outPath}?`,
            initialValue: true,
        });
        if (!ok) {
            out.outro("Aborted.");

            return;
        }
    }

    const spin = tty ? out.spinner() : null;
    spin?.start("Fetching discussions");
    const discussions = await restGetPaginated<Discussion>(
        api,
        `${projectBase(api)}/merge_requests/${mrIid}/discussions`
    ).catch((error: unknown) => {
        spin?.stop("Fetch failed.");
        throw error;
    });
    writeFileSync(outPath, SafeJSON.stringify(discussions, null, 2));
    spin?.stop(`Saved discussions JSON → ${outPath}`);
    if (!tty) {
        status.success(`Saved discussions JSON → ${outPath}`);
    }

    const compact = Boolean(opts.llm || opts.expand);

    if (format === "md" || format === "both" || compact) {
        // The tip first: its git fetch also brings in the reviewers' commits the checkout lacks.
        const tip = await fetchTipViews({
            api,
            iid: mrIid,
            cwd,
            discussions,
            fetchRemote: opts.anchors !== false,
            onWarn: status.warn,
        });
        const pairs = collectUnresolvedAnchorPairs(discussions);
        const { views, gitHits, total } = await fetchAnchorViews({
            pairs,
            api,
            fetchRemote: opts.anchors !== false,
            onWarn: status.warn,
            cwd,
        });
        status.success(
            `Fetched ${views.size}/${total} anchor view(s) (${gitHits} from local git, ${views.size - gitHits} from the API).`
        );

        const renderOpts = {
            mrIid,
            project: api.project,
            cwd,
            contextLines,
            anchorViews: views,
            tip,
            refs: await threadRefs(api, mrIid, discussions),
            nextSteps: config.review.nextSteps,
        };

        if (compact) {
            const command = `${toolCommand("gitlab pr", mrIid, "review", "--receive")}`;
            out.print(
                opts.expand
                    ? expandThreads(discussions, renderOpts, opts.expand.split(","))
                    : receiveIndex(discussions, renderOpts, command)
            );

            return;
        }

        const { md, threadCount, totalDiscussions, headShas, files } = renderMarkdown(discussions, renderOpts);
        if (opts.mdSidecar !== false) {
            const mdPath = `${outPath.replace(/\.json$/, "")}.md`;
            writeFileSync(mdPath, md);
            status.success(`Markdown report written → ${mdPath}`);
        }

        status.info(
            `Discussions: ${totalDiscussions} · Unresolved: ${threadCount} · Files: ${files} · Head_shas: ${headShas}`
        );
        if (!tty) {
            out.print(md);
        }
    } else {
        const stats = threadStats(discussions);
        status.info(
            `Discussions: ${discussions.length} · Unresolved: ${stats.threads} · Files: ${stats.files} · Head_shas: ${stats.headShas}`
        );
        // `--format json` wrote only the file, so the format it names never reached stdout.
        out.result(discussions);
    }

    if (schemaFormat !== "none") {
        status.info(`Schema (${schemaFormat}):`);
        const shape = formatSchema(discussions, schemaFormat as OutputMode, {
            pretty: true,
            rootName: "GitLabDiscussions",
            exported: true,
            schemaHeader: true,
        });

        for (const line of shape.split("\n")) {
            status.message(`  ${line}`);
        }
    }

    if (opts.schemaSidecar !== false) {
        const sidecarPath = `${outPath.replace(/\.json$/, "")}.schema.json`;
        writeFileSync(sidecarPath, formatSchema(discussions, "schema", { pretty: true, schemaHeader: true }));
        status.success(`Schema sidecar written → ${sidecarPath}`);
    }

    if (tty) {
        out.outro("Done.");
    } else {
        status.success("Done.");
    }
}
