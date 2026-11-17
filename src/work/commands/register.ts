import { writeFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { errorDiagnostic, failReply, okReply, type Reply } from "@genesiscz/utils/output/reply";
import { ingestLegacyHandoff, type ParityDifference, parityOf } from "@genesiscz/utils/work/legacy/shadow";
import type { ItemFields } from "@genesiscz/utils/work/model/item";
import {
    ITEM_STATES,
    ITEM_TYPES,
    type ItemType,
    isOneOf,
    LINK_KINDS,
    LOG_RESULTS,
    SEVERITIES,
    type Severity,
} from "@genesiscz/utils/work/model/vocab";
import { type ItemRow, listItems, showItem, type TriageRow, triage } from "@genesiscz/utils/work/read";
import { type ReopenData, reopen } from "@genesiscz/utils/work/reopen";
import { type WorkContext, type WriteData, write } from "@genesiscz/utils/work/service";
import { openWorkDb } from "@genesiscz/utils/work/store/db";
import type { WorkCommand } from "@genesiscz/utils/work/store/decide";
import type { Command } from "commander";
import { actorHere, legacyHandoffs, sessionDelivery, t3Lineage } from "../adapters";
import { openLegacySource } from "../adapters/legacy-source";
import { emit } from "./emit";

interface WriteFlags {
    json?: boolean;
    requestId?: string;
    dryRun?: boolean;
}

function list(value: string | undefined): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    return value
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

function context(): WorkContext {
    const { actor, project } = actorHere();
    return {
        db: openWorkDb(),
        actor,
        project,
        ports: { legacy: legacyHandoffs(), delivery: sessionDelivery(), lineage: t3Lineage() },
    };
}

/** A closed-value flag: the value, or a failed reply that lists the allowed values. */
function pick<T extends string>(
    verb: string,
    flag: string,
    values: readonly T[],
    raw: string | undefined
): T | undefined | Reply<never> {
    if (raw === undefined) {
        return undefined;
    }

    if (isOneOf(values, raw)) {
        return raw;
    }

    return failReply(verb, [errorDiagnostic("BAD_VALUE", `${flag} must be one of: ${values.join(", ")}.`, flag)]);
}

function isReply(value: unknown): value is Reply<never> {
    return typeof value === "object" && value !== null && "verb" in value && "diagnostics" in value;
}

function rowLine(row: ItemRow): string {
    const cells = [
        row.slot ? `${row.slot}` : "",
        row.ref,
        row.state,
        row.type,
        row.severity ?? "-",
        row.worker ?? "-",
        row.title,
    ];
    return (row.slot ? cells : cells.slice(1)).join("  ");
}

function writeText(data: WriteData): string[] {
    const lines = data.items.map((item) => `${item.id}  ${item.state}  ${item.type}  ${item.title}`);

    if (data.handoff !== undefined) {
        lines.unshift(`handoff ${data.handoff}`);
    }

    if (data.noop) {
        lines.push("(no change)");
    }

    return lines;
}

async function runWrite(command: WorkCommand, flags: WriteFlags): Promise<void> {
    const ctx = context();

    try {
        const reply = await write(ctx, command, {
            ...(flags.requestId !== undefined ? { request: flags.requestId } : {}),
            ...(flags.dryRun ? { dryRun: true } : {}),
        });
        emit(reply, flags, writeText);
    } finally {
        ctx.db.close();
    }
}

function fieldsOf(opts: {
    where?: string;
    why?: string;
    userSees?: string;
    cost?: string;
    existedBefore?: boolean;
    production?: boolean;
}): ItemFields {
    return {
        ...(opts.where !== undefined ? { where: opts.where } : {}),
        ...(opts.why !== undefined ? { why: opts.why } : {}),
        ...(opts.userSees !== undefined ? { userSees: opts.userSees } : {}),
        ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
        ...(opts.existedBefore ? { existedBefore: true } : {}),
        ...(opts.production ? { production: true } : {}),
    };
}

function withWriteFlags(command: Command): Command {
    return command
        .option("--request-id <id>", "a repeat with the same id returns the stored reply and writes nothing")
        .option("--dry-run", "print the changes, write nothing")
        .option("--json", "print the reply object as JSON");
}

const TYPES_HELP = ITEM_TYPES.join("|");
const SEVERITY_HELP = SEVERITIES.join("|");

export function registerWorkCommands(program: Command): void {
    withWriteFlags(
        program
            .command("spot")
            .description(
                "File a thing you saw and did not fix. It goes to the project inbox, paired with your live claim"
            )
            .argument("<title>", "one line: what is wrong")
            .requiredOption("--type <type>", TYPES_HELP)
            .option("--where <path:line>", "where you saw it")
            .option("--why <text>", "why it is wrong or matters")
            .option("--user-sees <text>", "what a user sees because of it")
            .option("--severity <level>", `${SEVERITY_HELP}; only when you judged it`)
            .option("--cost <text>", "what it costs to do now; only when you judged it")
            .option("--existed-before", "it was there before your change")
            .option("--production", "a live user can hit it")
            .option("--during <ref>", "the task or handoff you worked on (default: your one live claim)")
    ).action(
        async (
            title: string,
            opts: WriteFlags & { type: string; severity?: string; during?: string } & Parameters<typeof fieldsOf>[0]
        ) => {
            const type = pick("spot", "--type", ITEM_TYPES, opts.type);
            const severity = pick("spot", "--severity", SEVERITIES, opts.severity);

            if (isReply(type) || isReply(severity) || type === undefined) {
                emit(isReply(severity) ? severity : (type as Reply<never>), opts, () => []);
                return;
            }

            await runWrite(
                {
                    verb: "spot",
                    title,
                    type,
                    fields: fieldsOf(opts),
                    ...(severity !== undefined ? { severity } : {}),
                    ...(opts.during !== undefined ? { during: opts.during } : {}),
                },
                opts
            );
        }
    );

    withWriteFlags(
        program
            .command("add")
            .description("Add a work item; --under puts it into a handoff as a new task")
            .argument("<title>")
            .requiredOption("--type <type>", TYPES_HELP)
            .option("--parent <ref>", "its parent in the plan tree (one at most)")
            .option("--under <handoff>", "add it as a member of this handoff")
            .option("--for <who>", "who it is for")
            .option("--body <text>", "the longer text")
            .option("--acceptance <text>", "how a worker knows it is done")
    ).action(
        async (
            title: string,
            opts: WriteFlags & {
                type: string;
                parent?: string;
                under?: string;
                for?: string;
                body?: string;
                acceptance?: string;
            }
        ) => {
            const type = pick("add", "--type", ITEM_TYPES, opts.type);

            if (isReply(type) || type === undefined) {
                emit(type as Reply<never>, opts, () => []);
                return;
            }

            await runWrite(
                {
                    verb: "add",
                    title,
                    type,
                    ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
                    ...(opts.under !== undefined ? { under: opts.under } : {}),
                    ...(opts.for !== undefined ? { for: opts.for } : {}),
                    ...(opts.body !== undefined ? { body: opts.body } : {}),
                    ...(opts.acceptance !== undefined ? { acceptance: opts.acceptance } : {}),
                },
                opts
            );
        }
    );

    withWriteFlags(
        program
            .command("edit")
            .description("Change the type, severity, parent, owner, title or fields of an item")
            .argument("<ref>")
            .option("--type <type>", TYPES_HELP)
            .option("--severity <level>", SEVERITY_HELP)
            .option("--parent <ref>")
            .option("--for <who>")
            .option("--title <text>")
            .option("--where <path:line>")
            .option("--why <text>")
            .option("--user-sees <text>")
            .option("--cost <text>")
            .option("--during <ref>", "pair a spotted item with the task or handoff it was seen in")
    ).action(
        async (
            ref: string,
            opts: WriteFlags & {
                type?: string;
                severity?: string;
                parent?: string;
                for?: string;
                title?: string;
                during?: string;
            } & Parameters<typeof fieldsOf>[0]
        ) => {
            const type = pick("edit", "--type", ITEM_TYPES, opts.type);
            const severity = pick("edit", "--severity", SEVERITIES, opts.severity);

            if (isReply(type) || isReply(severity)) {
                emit(isReply(type) ? type : (severity as Reply<never>), opts, () => []);
                return;
            }

            await runWrite(
                {
                    verb: "edit",
                    ref,
                    fields: fieldsOf(opts),
                    ...(type !== undefined ? { type: type as ItemType } : {}),
                    ...(severity !== undefined ? { severity: severity as Severity } : {}),
                    ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
                    ...(opts.for !== undefined ? { for: opts.for } : {}),
                    ...(opts.title !== undefined ? { title: opts.title } : {}),
                    ...(opts.during !== undefined ? { during: opts.during } : {}),
                },
                opts
            );
        }
    );

    for (const verb of ["link", "unlink"] as const) {
        withWriteFlags(
            program
                .command(verb)
                .description(verb === "link" ? "Point one item at another" : "Remove a reference")
                .argument("<ref>")
                .argument("<kind>", LINK_KINDS.join("|"))
                .argument("<to>")
        ).action(async (ref: string, kind: string, to: string, opts: WriteFlags) => {
            const picked = pick(verb, "<kind>", LINK_KINDS, kind);

            if (isReply(picked) || picked === undefined) {
                emit(picked as Reply<never>, opts, () => []);
                return;
            }

            await runWrite({ verb, ref, kind: picked, to }, opts);
        });
    }

    program
        .command("list")
        .description("List items; one short row each")
        .option("--project <p>", "the main checkout folder name, e.g. GenesisTools")
        .option("--under <ref>", "members of a handoff, or children of an item")
        .option("--spotted-in <handoff>", "items spotted during this handoff or one of its tasks")
        .option("--state <s,…>", ITEM_STATES.join(","))
        .option("--type <t,…>", ITEM_TYPES.join(","))
        .option("--tag <t>")
        .option("--severity <l,…>", SEVERITIES.join(","))
        .option("--worker <me|session>", "the last worker: me, or a session id")
        .option("--fields <f,…>", "columns of a JSON row: ref,state,type,severity,worker,title,project,slot")
        .option("--limit <n>", "at most this many rows", "500")
        .option("--json", "print the reply object as JSON")
        .action(
            (opts: {
                project?: string;
                under?: string;
                spottedIn?: string;
                state?: string;
                type?: string;
                tag?: string;
                severity?: string;
                worker?: string;
                fields?: string;
                limit: string;
                json?: boolean;
            }) => {
                const db = openWorkDb();

                try {
                    let workerSession: string | undefined = opts.worker;

                    if (opts.worker === "me") {
                        workerSession = actorHere().actor.sessionId ?? "-";
                    }

                    const result = listItems(db, {
                        ...(opts.project !== undefined ? { project: opts.project } : {}),
                        ...(opts.under !== undefined ? { under: opts.under } : {}),
                        ...(opts.spottedIn !== undefined ? { spottedIn: opts.spottedIn } : {}),
                        ...(opts.state !== undefined ? { states: list(opts.state) } : {}),
                        ...(opts.type !== undefined ? { types: list(opts.type) } : {}),
                        ...(opts.severity !== undefined ? { severities: list(opts.severity) } : {}),
                        ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
                        ...(workerSession !== undefined ? { workerSession } : {}),
                        limit: Number.parseInt(opts.limit, 10) || 500,
                    });

                    if (!result.ok) {
                        emit(
                            failReply("list", [errorDiagnostic("NOT_FOUND", `No item ${result.missing}.`)]),
                            opts,
                            () => []
                        );
                        return;
                    }

                    const fields = list(opts.fields);
                    const rows = fields
                        ? result.rows.map((row) =>
                              Object.fromEntries(fields.map((f) => [f, (row as unknown as Record<string, unknown>)[f]]))
                          )
                        : result.rows;
                    emit(okReply("list", rows), opts, () =>
                        result.rows.length === 0 ? ["(no items)"] : result.rows.map(rowLine)
                    );
                } finally {
                    db.close();
                }
            }
        );

    program
        .command("show")
        .description("One item: its fields, references, pointers and work log")
        .argument("<ref>")
        .option("--section <name>", "body|log|refs|context")
        .option("--json", "print the reply object as JSON")
        .action((ref: string, opts: { section?: string; json?: boolean }) => {
            const db = openWorkDb();

            try {
                const shown = showItem(db, ref);

                if (shown === null) {
                    emit(failReply("show", [errorDiagnostic("NOT_FOUND", `No item ${ref}.`)]), opts, () => []);
                    return;
                }

                emit(okReply("show", shown), opts, (data) => {
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
                            `  ${c.ts.slice(0, 16)}  ${c.kind}  ${c.actor.sessionTitle ?? c.actor.sessionId ?? c.actor.harness}${summary(c.payload)}`
                    );

                    switch (opts.section) {
                        case "body":
                            return [
                                ...head,
                                item.body ?? "(no body)",
                                ...(item.acceptance ? [`acceptance: ${item.acceptance}`] : []),
                            ];
                        case "log":
                            return [...head, "log:", ...log];
                        case "refs":
                            return [
                                ...head,
                                "refs:",
                                ...refs,
                                ...data.pointers.map((p) => `  ⇢ ${p.kind}:${p.target}`),
                            ];
                        case "context":
                            return [
                                ...head,
                                ...data.log
                                    .filter((c) => c.stamp)
                                    .map((c) => `  ${c.seq}: ${SafeJSON.stringify(c.stamp)}`),
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
                });
            } finally {
                db.close();
            }
        });

    program
        .command("dump")
        .description("Write one item with everything it holds to a JSON file")
        .argument("<ref>")
        .requiredOption("--out <file>")
        .action((ref: string, opts: { out: string }) => {
            const db = openWorkDb();

            try {
                const shown = showItem(db, ref);

                if (shown === null) {
                    emit(failReply("dump", [errorDiagnostic("NOT_FOUND", `No item ${ref}.`)]), {}, () => []);
                    return;
                }

                writeFileSync(opts.out, `${SafeJSON.stringify(shown, null, 2)}\n`);
                emit(okReply("dump", { file: opts.out }), {}, (d) => [`wrote ${d.file}`]);
            } finally {
                db.close();
            }
        });

    program
        .command("triage")
        .description("The dangling check: what nobody owns, with a next action per row")
        .option("--project <p>")
        .option("--json", "print the reply object as JSON")
        .action(async (opts: { project?: string; json?: boolean }) => {
            const db = openWorkDb();
            const delivery = sessionDelivery();

            try {
                const rows = await triage(
                    db,
                    opts.project,
                    async (sessionId, harness) => (await delivery.place(sessionId, harness))?.live ?? null
                );
                emit(okReply("triage", rows), opts, triageText);
            } finally {
                db.close();
            }
        });

    withWriteFlags(
        program
            .command("accept")
            .description("Accept spotted items: spotted becomes open")
            .argument("<refs>", "comma-separated")
            .option("--type <type>", TYPES_HELP)
            .option("--severity <level>", SEVERITY_HELP)
    ).action(async (refs: string, opts: WriteFlags & { type?: string; severity?: string }) => {
        const type = pick("accept", "--type", ITEM_TYPES, opts.type);
        const severity = pick("accept", "--severity", SEVERITIES, opts.severity);

        if (isReply(type) || isReply(severity)) {
            emit(isReply(type) ? type : (severity as Reply<never>), opts, () => []);
            return;
        }

        await runWrite(
            {
                verb: "accept",
                refs: list(refs) ?? [],
                ...(type !== undefined ? { type: type as ItemType } : {}),
                ...(severity !== undefined ? { severity: severity as Severity } : {}),
            },
            opts
        );
    });

    withWriteFlags(
        program
            .command("drop")
            .description("Drop items nobody will do")
            .argument("<refs>", "comma-separated")
            .requiredOption("--why <text>")
    ).action(async (refs: string, opts: WriteFlags & { why: string }) => {
        await runWrite({ verb: "drop", refs: list(refs) ?? [], why: opts.why }, opts);
    });

    withWriteFlags(
        program
            .command("handoff")
            .description("Make a handoff from items: one write accepts them and adds them as its tasks")
            .argument("<title>")
            .requiredOption("--from <refs>", "comma-separated items")
            .option("--target <agent>", "claude|codex|grok|copilot")
            .option("--body <text>", "the handoff's description")
    ).action(async (title: string, opts: WriteFlags & { from: string; target?: string; body?: string }) => {
        await runWrite(
            {
                verb: "handoff",
                title,
                from: list(opts.from) ?? [],
                ...(opts.target !== undefined ? { target: opts.target } : {}),
                ...(opts.body !== undefined ? { body: opts.body } : {}),
            },
            opts
        );
    });

    withWriteFlags(
        program
            .command("finish")
            .description("Finish an item with its proof (a task of a handoff is ticked in the handoff too)")
            .argument("<ref>")
            .requiredOption("--proof <text>", "the command, where it ran, the commit")
            .option("--commits <sha,…>")
    ).action(async (ref: string, opts: WriteFlags & { proof: string; commits?: string }) => {
        await runWrite(
            {
                verb: "finish",
                ref,
                proof: opts.proof,
                ...(opts.commits !== undefined ? { commits: list(opts.commits) } : {}),
            },
            opts
        );
    });

    withWriteFlags(
        program
            .command("log")
            .description("Record one attempt on an item: fixed, partly, failed, or a limit with its number")
            .argument("<ref>")
            .requiredOption("--result <result>", LOG_RESULTS.join("|"))
            .option("--note <text>")
            .option("--measured <text>", '"<number, unit, target>", e.g. "42 ranges, 43 target"')
    ).action(async (ref: string, opts: WriteFlags & { result: string; note?: string; measured?: string }) => {
        const result = pick("log", "--result", LOG_RESULTS, opts.result);

        if (isReply(result) || result === undefined) {
            emit(result as Reply<never>, opts, () => []);
            return;
        }

        await runWrite(
            {
                verb: "log",
                ref,
                result,
                ...(opts.note !== undefined ? { note: opts.note } : {}),
                ...(opts.measured !== undefined ? { measured: opts.measured } : {}),
            },
            opts
        );
    });

    withWriteFlags(
        program.command("comment").description("Add a comment to an item").argument("<ref>").argument("<text>")
    ).action(async (ref: string, text: string, opts: WriteFlags) => {
        await runWrite({ verb: "comment", ref, text }, opts);
    });

    withWriteFlags(
        program
            .command("reopen")
            .description("Reopen a done or dropped item and tell its worker, with a delivery receipt")
            .argument("<ref>")
            .requiredOption("--why <text>", "what is still wrong, with the evidence")
            .option("--deliver <mode>", "never: reopen without a message", "auto")
    ).action(async (ref: string, opts: WriteFlags & { why: string; deliver: string }) => {
        const ctx = context();

        try {
            const reply = await reopen(ctx, {
                ref,
                why: opts.why,
                deliver: opts.deliver === "never" ? "never" : "auto",
                ...(opts.requestId !== undefined ? { request: opts.requestId } : {}),
                ...(opts.dryRun ? { dryRun: true } : {}),
            });
            emit(reply, opts, reopenText);
        } finally {
            ctx.db.close();
        }
    });

    const migrate = program.command("migrate").description("Bring the old stores into the work store");
    migrate
        .command("backfill")
        .description("Ingest every handoff of the old store (safe to repeat)")
        .option("--json", "print the reply object as JSON")
        .action((opts: { json?: boolean }) => {
            const db = openWorkDb();
            const source = openLegacySource({ catchUp: true });

            try {
                let handoffs = 0;
                let failed = 0;

                for (const handoff of source.handoffs()) {
                    try {
                        ingestLegacyHandoff(db, handoff, source.events(handoff.id));
                        handoffs++;
                    } catch (error) {
                        failed++;
                        out.warn(`${handoff.id}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }

                const items = (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
                const reply =
                    failed > 0
                        ? failReply<{ handoffs: number; failed: number; items: number }>("migrate backfill", [
                              errorDiagnostic("BACKFILL_FAILED", `${failed} handoffs failed; see the lines above.`),
                          ])
                        : okReply("migrate backfill", { handoffs, failed, items });
                emit(reply, opts, (d) => [`ingested ${d.handoffs} handoffs; the store holds ${d.items} items`]);
            } finally {
                source.close();
                db.close();
            }
        });

    program
        .command("doctor")
        .description("Check the work store; --parity compares it with the old handoff read model (a pure read)")
        .option("--parity", "compare every handoff with the old read model")
        .option("--json", "print the reply object as JSON")
        .action((opts: { parity?: boolean; json?: boolean }) => {
            const db = openWorkDb();
            const source = openLegacySource({ catchUp: false });

            try {
                const differences: ParityDifference[] = [];
                const handoffs = source.handoffs();

                for (const handoff of handoffs) {
                    differences.push(...parityOf(db, handoff));
                }

                const data = { handoffs: handoffs.length, differences };
                const reply: Reply<typeof data> =
                    differences.length === 0
                        ? okReply("doctor", data)
                        : {
                              ...okReply("doctor", data),
                              ok: false,
                              diagnostics: [
                                  errorDiagnostic(
                                      "PARITY",
                                      `${differences.length} differences. A process with old code wrote past the hook: restart it, then run tools work migrate backfill.`
                                  ),
                              ],
                          };

                if (reply.ok) {
                    emit(reply, opts, (d) => [`parity: ${d.handoffs} handoffs, 0 differences`]);
                } else {
                    if (!opts.json) {
                        out.print(
                            `${differences.map((d) => `${d.handoff}${d.slot ? `:${d.slot}` : ""}  ${d.what}`).join("\n")}\n`
                        );
                    }

                    emit(reply, opts, () => []);
                }
            } finally {
                source.close();
                db.close();
            }
        });
}

function summary(payload: unknown): string {
    if (payload === null || typeof payload !== "object") {
        return "";
    }

    const p = payload as Record<string, unknown>;

    if (typeof p.to === "string" && typeof p.from === "string") {
        return `  ${p.from} → ${p.to}${typeof p.why === "string" ? `: ${p.why}` : ""}`;
    }

    if (typeof p.text === "string") {
        return `  ${p.text.slice(0, 100)}`;
    }

    if (typeof p.kind === "string" && typeof p.to === "string") {
        return `  ${p.kind} ${p.to}`;
    }

    if (typeof p.result === "string") {
        return `  ${p.result}${typeof p.measured === "string" ? ` (${p.measured})` : ""}`;
    }

    if (typeof p.title === "string") {
        return `  ${p.title}`;
    }

    return "";
}

function triageText(rows: TriageRow[]): string[] {
    if (rows.length === 0) {
        return ["nothing dangles"];
    }

    const lines: string[] = [];
    let group = "";

    for (const row of rows.sort((a, b) => a.group.localeCompare(b.group))) {
        if (row.group !== group) {
            group = row.group;
            lines.push(`${group}:`);
        }

        lines.push(`  ${row.ref}  ${row.type}  ${row.severity ?? "-"}  ${row.title}`);

        for (const [label, value] of [
            ["where", row.where],
            ["why", row.why],
            ["user sees", row.userSees],
            [
                "spotted in",
                row.spottedIn ? `${row.spottedIn.ref} (${row.spottedIn.state}) ${row.spottedIn.title}` : undefined,
            ],
            ["spotted by", row.spottedBy],
        ] as const) {
            if (value !== undefined) {
                lines.push(`      ${label}: ${value}`);
            }
        }
    }

    return lines;
}

function reopenText(data: ReopenData): string[] {
    const lines = [`${data.item.id}  ${data.item.state}  ${data.item.title}`];

    if (data.receipt !== null) {
        const r = data.receipt;
        const to = r.to ? `${r.to.harness} ${r.to.sessionTitle ?? r.to.sessionId ?? "?"}` : "nobody";
        lines.push(
            `delivery: ${r.outcome} to ${to}${r.route ? ` via ${r.route}` : ""}${r.target ? ` (${r.target})` : ""}`
        );
    } else {
        lines.push("delivery: none (--deliver never)");
    }

    return lines;
}
