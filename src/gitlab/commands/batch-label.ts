/**
 * Add or remove labels on a batch of MRs, logging labels before and after per MR.
 *
 *   tools gitlab batch-label 12,34 --add "Stale" --dry-run
 *   tools gitlab batch-label 12,34 --add "Stale" --remove "Needs review"
 *
 * Every applied change is appended to ~/.genesis-tools/gitlab/label-batch.jsonl.
 */

import { writeFileSync } from "node:fs";
import { collect, type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { resolveProjectApi } from "@app/gitlab/lib/client";
import {
    appendLabelLedger,
    expectedLabels,
    fetchMrLabels,
    type LabelChange,
    ledgerPath,
    parseIids,
    parseLabels,
    projectLabelNames,
    putMrLabels,
    renderChangeTable,
    sameLabels,
} from "@app/gitlab/lib/label-batch";
import { pool } from "@app/gitlab/lib/pool";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface Options extends TargetOptions {
    add: string[];
    remove: string[];
    dryRun?: boolean;
    createMissing?: boolean;
    out?: string;
}

export function registerBatchLabel(parent: Command): Command {
    return withProject(
        parent
            .command("batch-label")
            .description("Add and/or remove labels on many MRs; prints and logs labels before and after per MR")
            .argument("<iids>", "Comma-separated MR iids (e.g. 12,34)")
            .option("--add <label>", "Label to add (repeatable or comma-separated)", collect, [])
            .option("--remove <label>", "Label to remove (repeatable or comma-separated)", collect, [])
            .option("--dry-run", "Fetch current labels and print the planned result without changing anything")
            .option("--create-missing", "Allow labels that do not exist in the project yet (GitLab creates them)")
            .option("--out <file>", "Write the per-MR before/after record as JSON")
    ).action(runBatchLabel);
}

async function runBatchLabel(iidsArg: string, opts: Options): Promise<void> {
    const iids = parseIids(iidsArg);
    const add = parseLabels(opts.add);
    const remove = parseLabels(opts.remove);
    const dryRun = Boolean(opts.dryRun);
    if (!add.length && !remove.length) {
        throw new Error("Nothing to do: pass --add and/or --remove");
    }

    const overlap = add.filter((l) => remove.includes(l));
    if (overlap.length) {
        throw new Error(`Label in both --add and --remove: ${overlap.join(", ")}`);
    }

    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    const known = new Set(await projectLabelNames(api));
    const unknown = add.filter((l) => !known.has(l));
    if (unknown.length && !opts.createMissing) {
        throw new Error(
            `Unknown project label(s): ${unknown.join(", ")}. Check the spelling or pass --create-missing.`
        );
    }

    out.println(`Project: ${api.project} on ${api.host}`);
    out.println(`MRs: ${iids.map((i) => `!${i}`).join(", ")}`);
    out.println(`Add: ${add.join(", ") || "(none)"}   Remove: ${remove.join(", ") || "(none)"}`);
    out.println(`Dry run: ${dryRun}`);
    out.println(`Ledger: ${ledgerPath()}`);
    out.println("---");

    const changes = await pool(iids, 4, async (iid): Promise<LabelChange> => {
        const mr = await fetchMrLabels(api, iid);
        const before = [...mr.labels].sort();
        const expected = expectedLabels(before, add, remove);
        const base = { iid, title: mr.title, webUrl: mr.web_url, before, expected };
        if (sameLabels(before, expected)) {
            return { ...base, after: before, ok: true, unchanged: true, status: 0 };
        }

        if (dryRun) {
            return { ...base, after: null, ok: true, unchanged: false, status: 0 };
        }

        const result = await putMrLabels(api, { iid, add, remove });
        const after = result.labels ? [...result.labels].sort() : null;
        appendLabelLedger({
            ts: new Date().toISOString(),
            project: api.project,
            iid,
            add,
            remove,
            before,
            after,
            ok: result.ok,
            dryRun: false,
            error: result.error,
        });
        if (result.ok && after && !sameLabels(after, expected)) {
            return {
                ...base,
                after,
                ok: false,
                unchanged: false,
                status: result.status,
                error: `expected ${expected.join(", ")}`,
            };
        }

        return { ...base, after, ok: result.ok, unchanged: false, status: result.status, error: result.error };
    });

    out.println(renderChangeTable(changes));
    const applied = changes.filter((c) => c.ok && !c.unchanged && c.after !== null);
    const planned = changes.filter((c) => c.ok && !c.unchanged && c.after === null);
    const unchanged = changes.filter((c) => c.unchanged);
    const failed = changes.filter((c) => !c.ok);
    out.println("\n=== SUMMARY ===");
    out.println(
        `${dryRun ? "Would change" : "Changed"}: ${dryRun ? planned.length : applied.length}  Unchanged: ${unchanged.length}  Failed: ${failed.length}`
    );
    if (failed.length) {
        out.println(`Failed iids (retry these): ${failed.map((c) => c.iid).join(",")}`);
    }

    if (opts.out) {
        writeFileSync(
            opts.out,
            `${SafeJSON.stringify({ ts: new Date().toISOString(), project: api.project, dryRun, add, remove, changes }, null, 2)}\n`
        );
        out.println(`Record written to ${opts.out}`);
    }

    if (failed.length) {
        process.exitCode = 1;
    }
}
