/**
 * `gitlab fetch-review` — the discussions of one MR as raw JSON (always saved) and a per-thread
 * Markdown report with code excerpts from the local working tree and the reviewer's frozen view.
 *
 * In a terminal it shows clack status lines and a confirm prompt; piped or redirected, it writes
 * plain status to stderr and the Markdown to stdout.
 *
 *   tools gitlab fetch-review <MR_IID> [--project group/name] [--cwd <checkout>] [--format md|json|both]
 */

import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { projectBase, resolveProjectApi, restGetPaginated } from "@app/gitlab/lib/client";
import {
    collectUnresolvedAnchorPairs,
    type Discussion,
    fetchAnchorViews,
    renderMarkdown,
    threadStats,
} from "@app/gitlab/lib/review-render";
import { SafeJSON } from "@genesiscz/utils/json";
import { formatSchema, type OutputMode } from "@genesiscz/utils/json-schema";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";

const FORMATS = ["md", "json", "both"] as const;
const SCHEMA_FORMATS = ["schema", "skeleton", "typescript", "none"] as const;

interface Options extends TargetOptions {
    cwd?: string;
    out?: string;
    format?: string;
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

export function registerFetchReview(parent: Command): Command {
    return withProject(
        parent
            .command("fetch-review")
            .description("Fetch MR discussions and render a per-thread Markdown report")
            .argument("<mr-iid>", "MR IID (the small number in the URL, not the global id)")
            .option(
                "--cwd <dir>",
                "Checkout to read code excerpts, git anchors and the origin remote from (default: current directory)"
            )
            .option("--out <file>", "Save JSON here (default: $TMPDIR/gitlab-review-<iid>.json)")
            .option("--format <fmt>", "Output format: md | json | both", "md")
            .option("--context-lines <n>", "Lines of code excerpt around each anchor", "3")
            .option(
                "--no-anchors",
                "Skip the API fallback for the reviewer's frozen view; views whose sha is in local history still come from git"
            )
            .option(
                "--schema-format <fmt>",
                "Print the inferred discussions schema: schema | skeleton | typescript | none",
                "none"
            )
            .option("--no-schema-sidecar", "Don't write a <out>.schema.json sidecar")
            .option("--no-md-sidecar", "Don't write the <out>.md sidecar")
            .option("--no-confirm", "Skip the confirm prompt in a terminal")
    ).action(runFetchReview);
}

async function runFetchReview(mrIid: string, opts: Options): Promise<void> {
    const tty = isTty();
    if (tty) {
        out.intro(`gitlab fetch-review ${mrIid}`);
    }

    if (!/^\d+$/.test(mrIid)) {
        throw new Error(`MR_IID must be a positive integer; got "${mrIid}".`);
    }

    const format = opts.format ?? "md";
    if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
        throw new Error(`Invalid --format ${format}; expected ${FORMATS.join(" | ")}`);
    }

    const schemaFormat = opts.schemaFormat ?? "none";
    if (!SCHEMA_FORMATS.includes(schemaFormat as (typeof SCHEMA_FORMATS)[number])) {
        throw new Error(`Invalid --schema-format ${schemaFormat}; expected ${SCHEMA_FORMATS.join(" | ")}`);
    }

    const contextLines = Math.max(0, Number.parseInt(opts.contextLines ?? "3", 10) || 3);
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

    if (format === "md" || format === "both") {
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

        const { md, threadCount, totalDiscussions, headShas, files } = renderMarkdown(discussions, {
            mrIid,
            project: api.project,
            cwd,
            contextLines,
            anchorViews: views,
        });
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
    }

    if (schemaFormat !== "none") {
        status.info(`Schema (${schemaFormat}):`);
        for (const line of formatSchema(discussions, schemaFormat as OutputMode, { pretty: true }).split("\n")) {
            status.message(`  ${line}`);
        }
    }

    if (opts.schemaSidecar !== false) {
        const sidecarPath = `${outPath.replace(/\.json$/, "")}.schema.json`;
        writeFileSync(sidecarPath, formatSchema(discussions, "schema", { pretty: true }));
        status.success(`Schema sidecar written → ${sidecarPath}`);
    }

    if (tty) {
        out.outro("Done.");
    } else {
        status.success("Done.");
    }
}
