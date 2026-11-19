/**
 * One formatter per method of `workApi`. The table is typed by the results, so a method without a formatter does not
 * compile. A table shape gives md, json-compact and toon with no more code.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { defineFormatter, type Formatter, type TableShape } from "@genesiscz/utils/output/formatter";
import type { Reply } from "@genesiscz/utils/output/reply";
import type { ContextFact } from "./context";
import type { ConfigResult, ContextResult, ListResult, TreeResult, WorkResults } from "./handlers";
import type { Change } from "./model/change";
import type { ItemRow, ShowResult, TriageRow } from "./read";
import type { ReopenData } from "./reopen";
import type { WriteData } from "./service";

const ROW_COLUMNS: TableShape["columns"] = [
    { key: "slot", title: "Slot" },
    { key: "ref", title: "Ref" },
    { key: "state", title: "State" },
    { key: "type", title: "Type" },
    { key: "severity", title: "Sev" },
    { key: "worker", title: "Worker" },
    { key: "title", title: "Title", max: 100 },
];

export function rowLine(row: ItemRow): string {
    const cells = [row.ref, row.state, row.type, row.severity ?? "-", row.worker ?? "-", row.title];
    return (row.slot ? [row.slot, ...cells] : cells).join("  ");
}

function isItemRow(row: ItemRow | Record<string, unknown>): row is ItemRow {
    return (
        typeof row.ref === "string" &&
        typeof row.state === "string" &&
        typeof row.type === "string" &&
        typeof row.title === "string" &&
        typeof row.project === "string"
    );
}

const writeFormatter = defineFormatter<WriteData>({
    text(data) {
        const lines = data.items.map((item) => `${item.id}  ${item.state}  ${item.type}  ${item.title}`);

        if (data.handoff !== undefined) {
            lines.unshift(`handoff ${data.handoff}`);
        }

        if (data.noop) {
            lines.push("(no change)");
        }

        return lines;
    },
    table(data) {
        return {
            columns: ROW_COLUMNS.filter((c) => c.key !== "slot" && c.key !== "worker"),
            rows: data.items.map((item) => ({
                ref: item.id,
                state: item.state,
                type: item.type,
                severity: item.severity,
                title: item.title,
            })),
        };
    },
});

function summary(change: Change): string {
    const p = change.payload;

    if (p === null || typeof p !== "object") {
        return "";
    }

    const read = (key: string): unknown => Reflect.get(p, key);
    const from = read("from");
    const to = read("to");

    if (typeof from === "string" && typeof to === "string") {
        const why = read("why");
        return `  ${from} → ${to}${typeof why === "string" ? `: ${why}` : ""}`;
    }

    const text = read("text");

    if (typeof text === "string") {
        return `  ${text.slice(0, 100)}`;
    }

    const kind = read("kind");

    if (typeof kind === "string" && typeof to === "string") {
        return `  ${kind} ${to}`;
    }

    const result = read("result");

    if (typeof result === "string") {
        const measured = read("measured");
        return `  ${result}${typeof measured === "string" ? ` (${measured})` : ""}`;
    }

    const title = read("title");
    return typeof title === "string" ? `  ${title}` : "";
}

function showText(data: ShowResult, section: string | undefined): string[] {
    const { item } = data;
    const head = [
        `${item.id}  ${item.state}  ${item.type}${item.severity ? `  ${item.severity}` : ""}  ${item.project}`,
        item.title,
    ];
    const fieldLines = Object.entries(item.fields).map(
        ([k, v]) => `  ${k}: ${typeof v === "string" ? v : SafeJSON.stringify(v)}`
    );
    const refs = [
        ...data.refs.out.map((r) => `  → ${r.kind}${r.slot ? ` ${r.slot}` : ""} ${r.to}`),
        ...data.refs.in.map((r) => `  ← ${r.kind}${r.slot ? ` ${r.slot}` : ""} ${r.from}`),
    ];
    const log = data.log.map(
        (c) =>
            `  ${c.ts.slice(0, 16)}  ${c.kind}  ${c.actor.sessionTitle ?? c.actor.sessionId ?? c.actor.harness}${summary(c)}`
    );

    switch (section) {
        case "body":
            return [...head, item.body ?? "(no body)", ...(item.acceptance ? [`acceptance: ${item.acceptance}`] : [])];
        case "log":
            return [...head, "log:", ...log];
        case "refs":
            return [...head, "refs:", ...refs, ...data.pointers.map((p) => `  ⇢ ${p.kind}:${p.target}`)];
        case "context":
            return [
                ...head,
                ...data.log.filter((c) => c.stamp).map((c) => `  ${c.seq}: ${SafeJSON.stringify(c.stamp)}`),
            ];
        default:
            return [
                ...head,
                ...(fieldLines.length > 0 ? ["fields:", ...fieldLines] : []),
                ...(refs.length > 0 ? ["refs:", ...refs] : []),
                ...(data.members && data.members.length > 0
                    ? ["members:", ...data.members.map((m) => `  ${rowLine(m)}`)]
                    : []),
                `log: ${data.log.length} changes (--section log)`,
            ];
    }
}

function factLine(fact: ContextFact, explain: boolean): string {
    const how = `${fact.how.method}${fact.how.strength ? ` ${fact.how.strength}` : ""}: ${fact.how.source}`;
    return explain
        ? `${fact.path} = ${fact.value}  (${how}; ${fact.how.evidence})`
        : `${fact.path} = ${fact.value}  (${how})`;
}

function triageText(rows: TriageRow[]): string[] {
    if (rows.length === 0) {
        return ["nothing dangles"];
    }

    const lines: string[] = [];
    let group = "";

    for (const row of [...rows].sort((a, b) => a.group.localeCompare(b.group))) {
        if (row.group !== group) {
            group = row.group;
            lines.push(`${group}:`);
        }

        lines.push(`  ${row.ref}  ${row.type}  ${row.severity ?? "-"}  ${row.title}`);
        const details: [string, string | undefined][] = [
            ["where", row.where],
            ["why", row.why],
            ["user sees", row.userSees],
            [
                "spotted in",
                row.spottedIn ? `${row.spottedIn.ref} (${row.spottedIn.state}) ${row.spottedIn.title}` : undefined,
            ],
            ["spotted by", row.spottedBy],
        ];

        for (const [label, value] of details) {
            if (value !== undefined) {
                lines.push(`      ${label}: ${value}`);
            }
        }
    }

    return lines;
}

function roleText(value: "anyone" | readonly string[]): string {
    return value === "anyone" ? "anyone" : value.length === 0 ? "nobody" : value.join(", ");
}

/** Options a door passes to a formatter that has views (`show --section`, `context --explain`, `config --explain`). */
export interface ViewOptions {
    section?: string;
    explain?: boolean;
}

export function workFormatters(view: ViewOptions = {}): { [M in keyof WorkResults]: Formatter<WorkResults[M]> } {
    return {
        list: defineFormatter<ListResult>({
            text: (rows) =>
                rows.length === 0
                    ? ["(no items)"]
                    : rows.map((row) => (isItemRow(row) ? rowLine(row) : SafeJSON.stringify(row))),
            table: (rows) => ({
                columns:
                    rows.length > 0 && !isItemRow(rows[0])
                        ? Object.keys(rows[0]).map((key) => ({ key, title: key }))
                        : ROW_COLUMNS,
                rows: rows.map((row) => ({ ...row })),
            }),
        }),
        show: defineFormatter<ShowResult>({ text: (data) => showText(data, view.section) }),
        tree: defineFormatter<TreeResult>({
            text: (data) => [
                `project ${data.project}: ${data.containers.length} open containers, ${data.spotted} spotted`,
                ...data.containers.flatMap((c) => [
                    `${c.ref}  ${c.type}  ${c.state}  ${c.open}/${c.total} open  ${c.title}`,
                    ...c.members.map((m) => `  ${rowLine(m)}`),
                ]),
            ],
        }),
        triage: defineFormatter<TriageRow[]>({
            text: triageText,
            table: (rows) => ({
                columns: [
                    { key: "group", title: "Group" },
                    { key: "ref", title: "Ref" },
                    { key: "type", title: "Type" },
                    { key: "title", title: "Title", max: 100 },
                    { key: "where", title: "Where" },
                ],
                rows: rows.map((row) => ({ ...row })),
            }),
        }),
        context: defineFormatter<ContextResult>({
            text(data) {
                const lines = [`session ${data.session ?? "(none)"} (${data.harness})`];
                const current = Object.values(data.current);
                lines.push(
                    ...(current.length > 0
                        ? current.map((f) => factLine(f, view.explain === true))
                        : ["no current facts"])
                );

                if (view.explain && data.candidates.length > 0) {
                    lines.push("candidates:", ...data.candidates.map((f) => `  ${factLine(f, true)}`));
                }

                return lines;
            },
        }),
        config: defineFormatter<ConfigResult>({
            text(data) {
                const lines = [
                    `project ${data.project}`,
                    ...data.sources.map((s) => `  layer ${s.layer}: ${s.path ?? "?"}`),
                ];

                for (const row of data.rows) {
                    lines.push(`${row.type}:`);

                    for (const { field, resolved } of row.fields) {
                        const measure = resolved.value.measure ? `: ${resolved.value.measure}` : "";
                        lines.push(`  field ${field}: ${resolved.value.level} (from ${resolved.from})${measure}`);

                        if (view.explain) {
                            lines.push(
                                ...resolved.layers.map((l) => `      ${l.layer}: ${l.value ? l.value.level : "-"}`)
                            );
                        }
                    }

                    for (const { verb, resolved } of row.writes) {
                        lines.push(`  write ${verb}: ${roleText(resolved.value)} (from ${resolved.from})`);

                        if (view.explain) {
                            lines.push(
                                ...resolved.layers.map(
                                    (l) => `      ${l.layer}: ${l.value === undefined ? "-" : roleText(l.value)}`
                                )
                            );
                        }
                    }
                }

                return lines;
            },
        }),
        spot: writeFormatter,
        add: writeFormatter,
        edit: writeFormatter,
        link: writeFormatter,
        unlink: writeFormatter,
        accept: writeFormatter,
        claim: writeFormatter,
        release: writeFormatter,
        finish: writeFormatter,
        drop: writeFormatter,
        comment: writeFormatter,
        log: writeFormatter,
        handoff: writeFormatter,
        addMember: writeFormatter,
        reopen: defineFormatter<ReopenData>({
            text(data) {
                const lines = [`${data.item.id}  ${data.item.state}  ${data.item.title}`];

                if (data.receipt === null) {
                    lines.push("delivery: none (--deliver never)");
                    return lines;
                }

                const r = data.receipt;
                const to = r.to ? `${r.to.harness} ${r.to.sessionTitle ?? r.to.sessionId ?? "?"}` : "nobody";
                lines.push(
                    `delivery: ${r.outcome} to ${to}${r.route ? ` via ${r.route}` : ""}${r.target ? ` (${r.target})` : ""}`
                );
                return lines;
            },
        }),
        pair: defineFormatter<WorkResults["pair"]>({
            text: (d) => [
                `${d.pairing.item}  ${d.pairing.connector}  ${d.pairing.remoteKey}`,
                `push: ${d.push.pushed} pushed, ${d.push.held} held, ${d.push.failed} failed`,
            ],
        }),
        unpair: defineFormatter<WorkResults["unpair"]>({
            text: (d) => [d.removed ? "pairing removed" : "no such pairing"],
        }),
        pull: defineFormatter<WorkResults["pull"]>({
            text: (d) => [
                `made ${d.made.length}${d.made.length > 0 ? `: ${d.made.join(", ")}` : ""}`,
                `updated ${d.updated.length}${d.updated.length > 0 ? `: ${d.updated.join(", ")}` : ""}`,
                `drift ${d.drift.length}${d.drift.length > 0 ? `: ${d.drift.join(", ")}` : ""}`,
            ],
        }),
        sync: defineFormatter<WorkResults["sync"]>({
            text: (d) => [
                d.skipped !== undefined
                    ? `skipped: ${d.skipped} (another runner holds the lease)`
                    : `${d.pushed} pushed, ${d.held} held, ${d.failed} failed, ${d.drift} drift`,
            ],
        }),
        batch: defineFormatter<Reply<unknown>[]>({
            text: (replies) => replies.map((r, i) => `${i + 1}. ${r.verb}: ${r.ok ? "ok" : "failed"}`),
        }),
    };
}
