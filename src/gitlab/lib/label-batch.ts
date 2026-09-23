import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ProjectApi, projectBase, restGet, restGetPaginated, restWrite } from "@app/gitlab/lib/client";
import { storage } from "@app/gitlab/lib/config";
import { HttpError } from "@app/gitlab/lib/http";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface LabelChange {
    iid: number;
    title: string;
    webUrl: string;
    before: string[];
    expected: string[];
    after: string[] | null;
    ok: boolean;
    unchanged: boolean;
    status: number;
    error?: string;
}

export interface LabelLedgerEntry {
    ts: string;
    project: string;
    iid: number;
    add: string[];
    remove: string[];
    before: string[];
    after: string[] | null;
    ok: boolean;
    dryRun: boolean;
    error?: string;
}

interface MrLabels {
    iid: number;
    title: string;
    web_url: string;
    labels: string[];
}

export function ledgerPath(): string {
    const dir = storage.getBaseDir();
    mkdirSync(dir, { recursive: true });

    return join(dir, "label-batch.jsonl");
}

export function appendLabelLedger(entry: LabelLedgerEntry): void {
    appendFileSync(ledgerPath(), `${SafeJSON.stringify(entry)}\n`);
}

export function readLabelLedger(): LabelLedgerEntry[] {
    const path = ledgerPath();
    if (!existsSync(path)) {
        return [];
    }

    const entries: LabelLedgerEntry[] = [];

    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        try {
            entries.push(SafeJSON.parse(line, { strict: true }) as LabelLedgerEntry);
        } catch (error) {
            logger.debug({ error, path }, "gitlab: skipping unparsable label ledger line");
        }
    }

    return entries;
}

export function parseIids(arg: string): number[] {
    const iids = arg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const bad = iids.filter((s) => !/^\d+$/.test(s));
    if (bad.length) {
        throw new Error(`MR iids must be numbers, got: ${bad.join(", ")}`);
    }

    return [...new Set(iids.map(Number))];
}

export function parseLabels(values: string[]): string[] {
    return [
        ...new Set(
            values
                .flatMap((v) => v.split(","))
                .map((s) => s.trim())
                .filter(Boolean)
        ),
    ];
}

export function expectedLabels(before: string[], add: string[], remove: string[]): string[] {
    const set = new Set(before);
    for (const label of remove) {
        set.delete(label);
    }

    for (const label of add) {
        set.add(label);
    }

    return [...set].sort();
}

export function sameLabels(a: string[], b: string[]): boolean {
    const x = [...a].sort();
    const y = [...b].sort();

    return x.length === y.length && x.every((v, i) => v === y[i]);
}

export async function projectLabelNames(api: ProjectApi): Promise<string[]> {
    const labels = await restGetPaginated<{ name: string }>(api, `${projectBase(api)}/labels`);

    return labels.map((l) => l.name);
}

export async function fetchMrLabels(api: ProjectApi, iid: number): Promise<MrLabels> {
    return restGet<MrLabels>(api, `${projectBase(api)}/merge_requests/${iid}`);
}

export async function putMrLabels(
    api: ProjectApi,
    change: { iid: number; add: string[]; remove: string[] }
): Promise<{ ok: boolean; status: number; labels: string[] | null; error?: string }> {
    const body: Record<string, string> = {};
    if (change.add.length) {
        body.add_labels = change.add.join(",");
    }

    if (change.remove.length) {
        body.remove_labels = change.remove.join(",");
    }

    try {
        const data = await restWrite<MrLabels>(api, {
            method: "PUT",
            path: `${projectBase(api)}/merge_requests/${change.iid}`,
            body,
            retries: 1,
        });

        return { ok: true, status: 200, labels: data.labels };
    } catch (e) {
        if (e instanceof HttpError) {
            return { ok: false, status: e.status, labels: null, error: (e.body ?? "").slice(0, 200) };
        }

        const msg = e instanceof Error ? e.message : String(e);

        return { ok: false, status: 0, labels: null, error: msg.slice(0, 200) };
    }
}

export function renderChangeTable(changes: LabelChange[]): string {
    const rows = changes.map((c) => {
        const after = (c.after ?? c.expected).join(", ") || "(none)";
        const state = c.unchanged
            ? "unchanged"
            : !c.ok
              ? `FAIL ${c.status} ${c.error ?? ""}`.trim()
              : c.after === null
                ? "planned"
                : "ok";

        return `| !${c.iid} | ${c.before.join(", ") || "(none)"} | ${after} | ${state} |`;
    });

    return ["| MR | before | after | result |", "|---|---|---|---|", ...rows].join("\n");
}
