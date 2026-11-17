/**
 * The handler of each method of `workApi`. Every door calls these: the CLI, the MCP tools, the REPL and the actions
 * area. A handler returns a `Reply`; it never prints.
 */
import { errorDiagnostic, failReply, okReply, type Reply } from "@genesiscz/utils/output/reply";
import { type WorkMethodName, type WorkParams, workMethods } from "./api";
import { type ContextReport, stampOf } from "./context";
import type { Item } from "./model/item";
import { ITEM_TYPES, type ItemType, isOpenState } from "./model/vocab";
import { type ItemRow, type Liveness, listItems, type ShowResult, showItem, type TriageRow, triage } from "./read";
import { type ReopenData, reopen } from "./reopen";
import type { FieldRule, RoleRule } from "./rules/config";
import { RULE_FIELDS, type RuleField, WRITE_VERBS, type WriteVerb } from "./rules/config";
import { loadWorkRules } from "./rules/load";
import type { Resolved } from "./rules/resolve";
import { type WorkContext, type WriteData, write } from "./service";
import type { WorkCommand } from "./store/decide";
import { selectItems } from "./store/view";

export interface CallOptions {
    request?: string;
    dryRun?: boolean;
    ownerSaid?: string;
}

/** What a door gives each call: the store context, the per-call options, and the tool-side lookups. */
export interface WorkSession {
    ctx: WorkContext;
    call: CallOptions;
    alive: Liveness;
    /** The preflight context; the door builds it (git, the forge, T3 state). */
    context(network: boolean): Promise<ContextReport>;
}

export interface TreeContainer {
    ref: string;
    type: ItemType;
    state: Item["state"];
    title: string;
    open: number;
    total: number;
    members: ItemRow[];
}

export interface TreeResult {
    project: string;
    containers: TreeContainer[];
    spotted: number;
}

export interface ContextResult extends ContextReport {
    session: string | null;
    harness: string;
}

export interface ConfigRow {
    type: ItemType;
    fields: { field: RuleField; resolved: Resolved<FieldRule> }[];
    writes: { verb: WriteVerb; resolved: Resolved<RoleRule> }[];
}

export interface ConfigResult {
    project: string;
    sources: { layer: string; path: string | null }[];
    rows: ConfigRow[];
}

export type ListResult = (ItemRow | Record<string, unknown>)[];

export interface WorkResults {
    list: ListResult;
    show: ShowResult;
    tree: TreeResult;
    triage: TriageRow[];
    context: ContextResult;
    config: ConfigResult;
    spot: WriteData;
    add: WriteData;
    edit: WriteData;
    link: WriteData;
    unlink: WriteData;
    accept: WriteData;
    claim: WriteData;
    release: WriteData;
    finish: WriteData;
    drop: WriteData;
    comment: WriteData;
    log: WriteData;
    reopen: ReopenData;
    handoff: WriteData;
    batch: Reply<unknown>[];
}

export type WorkHandlers = {
    [M in WorkMethodName]: (params: WorkParams<M>, session: WorkSession) => Promise<Reply<WorkResults[M]>>;
};

function fieldsOf(p: {
    where?: string;
    why?: string;
    userSees?: string;
    cost?: string;
    existedBefore?: boolean;
    production?: boolean;
}) {
    return {
        ...(p.where !== undefined ? { where: p.where } : {}),
        ...(p.why !== undefined ? { why: p.why } : {}),
        ...(p.userSees !== undefined ? { userSees: p.userSees } : {}),
        ...(p.cost !== undefined ? { cost: p.cost } : {}),
        ...(p.existedBefore ? { existedBefore: true } : {}),
        ...(p.production ? { production: true } : {}),
    };
}

function strip<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function run(session: WorkSession, command: WorkCommand): Promise<Reply<WriteData>> {
    const ctx: WorkContext =
        session.call.ownerSaid !== undefined ? { ...session.ctx, ownerSaid: session.call.ownerSaid } : session.ctx;
    return write(ctx, command, strip({ request: session.call.request, dryRun: session.call.dryRun }));
}

export const workHandlers: WorkHandlers = {
    async list(p, session) {
        const workerSession = p.worker === "me" ? (session.ctx.actor.sessionId ?? "-") : p.worker;
        const result = listItems(
            session.ctx.db,
            strip({
                project: p.project,
                under: p.under,
                spottedIn: p.spottedIn,
                states: p.state,
                types: p.type,
                severities: p.severity,
                tag: p.tag,
                workerSession,
                limit: p.limit,
            })
        );

        if (!result.ok) {
            return failReply("list", [errorDiagnostic("NOT_FOUND", `No item ${result.missing}.`)]);
        }

        const fields = p.fields;
        const rows: ListResult = fields
            ? result.rows.map((row) => Object.fromEntries(fields.map((f) => [f, Reflect.get(row, f)])))
            : result.rows;
        return okReply("list", rows);
    },

    async show(p, session) {
        const shown = showItem(session.ctx.db, p.ref);
        return shown === null
            ? failReply("show", [errorDiagnostic("NOT_FOUND", `No item ${p.ref}.`)])
            : okReply("show", shown);
    },

    async tree(p, session) {
        const project = p.project ?? session.ctx.project;
        const containers = selectItems(session.ctx.db, { project, types: ["handoff", "epic"], limit: 5000 }).filter(
            (item) => p.all === true || isOpenState(item.state)
        );
        const out: TreeContainer[] = containers.map((item) => {
            const listed = listItems(session.ctx.db, { under: item.id });
            const members = listed.ok ? listed.rows : [];
            return {
                ref: item.id,
                type: item.type,
                state: item.state,
                title: item.title,
                open: members.filter((m) => isOpenState(m.state)).length,
                total: members.length,
                members,
            };
        });
        const spotted = selectItems(session.ctx.db, { project, states: ["spotted"], limit: 5000 }).length;
        return okReply("tree", { project, containers: out, spotted });
    },

    async triage(p, session) {
        return okReply("triage", await triage(session.ctx.db, p.project, session.alive));
    },

    async context(p, session) {
        const report = await session.context(p.network === true);
        return okReply("context", {
            session: session.ctx.actor.sessionId,
            harness: session.ctx.actor.harness,
            ...report,
        });
    },

    async config(p, session) {
        const project = p.project ?? session.ctx.project;
        const loaded = await loadWorkRules({
            project,
            repoRoot: p.project === undefined ? session.ctx.actor.repoRoot : null,
        });
        const types = p.type ?? [...ITEM_TYPES];
        const rows: ConfigRow[] = types.map((type) => ({
            type,
            fields: RULE_FIELDS.map((field) => ({ field, resolved: loaded.rules.field(type, field) })).filter(
                (entry) => entry.resolved.value.level !== "optional"
            ),
            writes: WRITE_VERBS.map((verb) => ({ verb, resolved: loaded.rules.mayWrite(type, verb) })),
        }));
        return okReply("config", { project, sources: loaded.sources, rows }, { diagnostics: loaded.problems });
    },

    async spot(p, session) {
        let ctx = session.ctx;

        if (p.during === undefined) {
            // Its stamp goes into the journal; a strong inferred handoff pairs the item when no claim names one.
            const report = await session.context(false);
            const handoff = report.current.handoff;
            ctx = {
                ...ctx,
                stamp: stampOf(report),
                ...(handoff !== undefined && handoff.how.method === "inferred"
                    ? { inferred: { during: handoff.value, evidence: handoff.how.evidence } }
                    : {}),
            };
        }

        return run(
            { ...session, ctx },
            strip({
                verb: "spot" as const,
                title: p.title,
                type: p.type,
                fields: fieldsOf(p),
                severity: p.severity,
                during: p.during,
            })
        );
    },

    async add(p, session) {
        return run(
            session,
            strip({
                verb: "add" as const,
                title: p.title,
                type: p.type,
                parent: p.parent,
                under: p.under,
                for: p.for,
                body: p.body,
                acceptance: p.acceptance,
            })
        );
    },

    async edit(p, session) {
        return run(
            session,
            strip({
                verb: "edit" as const,
                ref: p.ref,
                type: p.type,
                severity: p.severity,
                parent: p.parent,
                for: p.for,
                title: p.title,
                during: p.during,
                fields: fieldsOf(p),
            })
        );
    },

    async link(p, session) {
        return run(session, { verb: "link", ref: p.ref, kind: p.kind, to: p.to });
    },

    async unlink(p, session) {
        return run(session, { verb: "unlink", ref: p.ref, kind: p.kind, to: p.to });
    },

    async accept(p, session) {
        return run(session, strip({ verb: "accept" as const, refs: p.refs, type: p.type, severity: p.severity }));
    },

    async claim(p, session) {
        return run(session, { verb: "claim", ref: p.ref });
    },

    async release(p, session) {
        return run(session, { verb: "release", ref: p.ref });
    },

    async finish(p, session) {
        return run(session, strip({ verb: "finish" as const, ref: p.ref, proof: p.proof, commits: p.commits }));
    },

    async drop(p, session) {
        return run(session, { verb: "drop", refs: p.refs, why: p.why });
    },

    async comment(p, session) {
        return run(session, { verb: "comment", ref: p.ref, text: p.text });
    },

    async log(p, session) {
        return run(
            session,
            strip({ verb: "log" as const, ref: p.ref, result: p.result, note: p.note, measured: p.measured })
        );
    },

    async reopen(p, session) {
        const ctx: WorkContext =
            session.call.ownerSaid !== undefined ? { ...session.ctx, ownerSaid: session.call.ownerSaid } : session.ctx;
        return reopen(
            ctx,
            strip({
                ref: p.ref,
                why: p.why,
                deliver: p.deliver,
                request: session.call.request,
                dryRun: session.call.dryRun,
            })
        );
    },

    async handoff(p, session) {
        return run(
            session,
            strip({ verb: "handoff" as const, title: p.title, from: p.from, target: p.target, body: p.body })
        );
    },

    async batch(p, session) {
        const replies: Reply<unknown>[] = [];

        for (const [index, call] of p.calls.entries()) {
            const reply = await callWork(call.method, call.params, {
                ...session,
                call: {
                    ...session.call,
                    ...(session.call.request !== undefined ? { request: `${session.call.request}#${index}` } : {}),
                },
            });
            replies.push(reply);

            if (!reply.ok) {
                return failReply("batch", [
                    errorDiagnostic(
                        "BATCH_STOPPED",
                        `Call ${index + 1} (${call.method}) failed; the rest did not run.`
                    ),
                    ...reply.diagnostics,
                ]);
            }
        }

        return okReply("batch", replies);
    },
};

function isMethod(name: string): name is WorkMethodName {
    return Object.hasOwn(workMethods, name);
}

/** Calls one method by name with raw params: the params are parsed by the method's schema first. */
export async function callWork(method: string, params: unknown, session: WorkSession): Promise<Reply<unknown>> {
    if (!isMethod(method)) {
        return failReply(method, [
            errorDiagnostic("UNKNOWN_METHOD", `No method ${method}. Methods: ${Object.keys(workMethods).join(", ")}.`),
        ]);
    }

    const parsed = workMethods[method].params.safeParse(params ?? {});

    if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ");
        return failReply(method, [errorDiagnostic("BAD_PARAMS", `${method}: ${detail}`)]);
    }

    const handler = workHandlers[method] as (p: unknown, s: WorkSession) => Promise<Reply<unknown>>;
    return handler(parsed.data, session);
}
