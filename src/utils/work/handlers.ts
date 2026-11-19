/**
 * The handler of each method of `workApi`. Every door calls these: the CLI, the MCP tools, the REPL and the actions
 * area. A handler returns a `Reply`; it never prints.
 */
import { errorDiagnostic, failReply, infoDiagnostic, okReply, type Reply } from "@genesiscz/utils/output/reply";
import { type WorkMethodName, type WorkParams, workMethods } from "./api";
import {
    type PullReport,
    pairItem,
    pullRemote,
    pushPairing,
    releaseHeld,
    runSyncOnce,
    type SyncDeps,
    type SyncReport,
    unpairItem,
} from "./connectors/sync";
import { originFor, type Pairing } from "./connectors/types";
import { type ContextReport, stampOf } from "./context";
import type { Item } from "./model/item";
import { ITEM_TYPES, type ItemType, isOpenState, OPEN_STATES, type Severity } from "./model/vocab";
import { defaultNotify, type ResolvedNotify, resolveNotify } from "./notify";
import { pairingsForRows, type RowPairings } from "./pairing-rows";
import { type ItemRow, type Liveness, listItems, type ShowResult, showItem, type TriageRow, triage } from "./read";
import { type ReopenData, reopen } from "./reopen";
import type { FieldRule, NotifyLevel, NotifyRule, RoleRule } from "./rules/config";
import {
    NOTIFY_ACTIONS,
    type NotifyAction,
    RULE_FIELDS,
    type RuleField,
    WRITE_VERBS,
    type WriteVerb,
} from "./rules/config";
import {
    type LoadedRules,
    type LoadProjectRules,
    loadWorkRules,
    type NotifyConfigChange,
    setWorkNotifyConfig,
} from "./rules/load";
import type { Resolved } from "./rules/resolve";
import { randomItemSuffix, type WorkContext, type WriteData, write } from "./service";
import type { WorkCommand } from "./store/decide";
import { newItemId } from "./store/decide";
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
    loadRules?: LoadProjectRules;
    /** The machine file this session edits; tests supply a temporary file. */
    configPath?: string;
    /** The preflight context; the door builds it (git, the forge, T3 state). */
    context(network: boolean): Promise<ContextReport>;
}

export interface TreeContainer extends RowPairings {
    ref: string;
    type: ItemType;
    state: Item["state"];
    title: string;
    open: number;
    total: number;
    members: (ItemRow & RowPairings)[];
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

export interface ConfigNotifyEditor extends ResolvedNotify {
    builtInLevel: NotifyLevel;
    minSeverity?: Severity;
    repoPath: string | null;
    layers: (ResolvedNotify["layers"][number] & {
        rule: NotifyRule | null;
        wildcard: boolean;
        fallback?: NotifyLevel;
    })[];
}

export interface ConfigRow {
    type: ItemType;
    fields: { field: RuleField; resolved: Resolved<FieldRule> }[];
    writes: { verb: WriteVerb; resolved: Resolved<RoleRule> }[];
    /** Who hears about each action on this type (P8 decision 4): the level of each layer and the one that decides. */
    notify: { action: NotifyAction; resolved: ResolvedNotify; editor: ConfigNotifyEditor }[];
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
    triage: (TriageRow & RowPairings)[];
    context: ContextResult;
    config: ConfigResult;
    configSet: { changed: NotifyConfigChange[]; file: string };
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
    addMember: WriteData;
    pair: PairData;
    unpair: { removed: boolean };
    pull: PullReport;
    sync: SyncReport;
    batch: Reply<unknown>[];
}

export interface PairData {
    pairing: Pairing;
    push: SyncReport;
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
        ...(p.existedBefore !== undefined ? { existedBefore: p.existedBefore } : {}),
        ...(p.production !== undefined ? { production: p.production } : {}),
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

/** The sync's view of this call's project, or a refusal when the door has no connectors or the ref is unknown. */
function syncOf(session: WorkSession, verb: string): { deps: SyncDeps } | { refused: Reply<never> } {
    const port = session.ctx.ports.connectors;

    if (port === undefined) {
        return {
            refused: failReply(verb, [
                errorDiagnostic(
                    "CONNECTORS_MISSING",
                    "This door has no connectors; the work CLI and the work_write MCP tool have them."
                ),
            ]),
        };
    }

    return { deps: port.syncDeps() };
}

function itemOf(session: WorkSession, verb: string, ref: string): { item: Item } | { refused: Reply<never> } {
    const shown = showItem(session.ctx.db, ref);

    if (shown === null) {
        return { refused: failReply(verb, [errorDiagnostic("NOT_FOUND", `No item ${ref}.`, "ref")]) };
    }

    return { item: shown.item };
}

function knownConnector(deps: SyncDeps, verb: string, id: string): Reply<never> | null {
    if (Object.hasOwn(deps.connectors, id)) {
        return null;
    }

    return failReply(verb, [
        errorDiagnostic(
            "UNKNOWN_CONNECTOR",
            `No connector ${id}. Connectors: ${Object.keys(deps.connectors).join(", ") || "none"}.`,
            "connector"
        ),
    ]);
}

/** A rule editor shows the stored level and threshold, rather than testing an event with no severity. */
function notifyForConfig({
    loaded,
    type,
    action,
}: {
    loaded: LoadedRules;
    type: ItemType;
    action: NotifyAction;
}): ConfigNotifyEditor {
    const builtInLevel = defaultNotify({ type, action });
    const result: ConfigNotifyEditor = {
        level: builtInLevel,
        from: "default",
        builtInLevel,
        repoPath: loaded.sources.find((source) => source.layer === "config.repo")?.path ?? null,
        layers: [{ layer: "default", value: builtInLevel, rule: null, wildcard: false }],
    };

    for (const entry of loaded.notifyLayers) {
        if (entry.layer !== "config.global" && entry.layer !== "config.repo" && entry.layer !== "config.project") {
            continue;
        }

        const concrete = entry.rules?.notify?.[type]?.[action];
        const fallback = entry.rules?.notify?.["*"]?.[action];
        const rule = concrete ?? fallback;
        const level = typeof rule === "string" ? rule : rule?.level;
        result.layers.push({
            layer: entry.layer,
            ...(level !== undefined ? { value: level } : {}),
            rule: rule ?? null,
            wildcard: concrete === undefined && rule !== undefined,
            ...(concrete && fallback ? { fallback: typeof fallback === "string" ? fallback : fallback.level } : {}),
        });

        if (level !== undefined) {
            result.level = level;
            result.from = entry.layer;
            result.minSeverity = typeof rule === "object" ? rule.minSeverity : undefined;
        }
    }

    return result;
}

function rulesForConfig(session: WorkSession, project: string): Promise<LoadedRules> {
    const location = {
        project,
        repoRoot: project === session.ctx.project ? session.ctx.actor.repoRoot : null,
    };
    return session.loadRules
        ? session.loadRules(location)
        : loadWorkRules({ ...location, configPath: session.configPath });
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
        const containers = selectItems(session.ctx.db, {
            project,
            types: ["handoff", "epic"],
            ...(p.all === true ? {} : { states: [...OPEN_STATES] }),
            limit: 5000,
        });
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
        const withPairings = await pairingsForRows(
            session.ctx,
            out.flatMap((row) => [row.ref, ...row.members.map((member) => member.ref)])
        );
        return okReply("tree", {
            project,
            containers: out.map((row) => withPairings({ ...row, members: row.members.map(withPairings) })),
            spotted,
        });
    },

    async triage(p, session) {
        const rows = await triage(session.ctx.db, p.project, session.alive);
        const withPairings = await pairingsForRows(
            session.ctx,
            rows.map((row) => row.ref)
        );
        return okReply("triage", rows.map(withPairings));
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
        const loaded = await rulesForConfig(session, project);
        const types = p.type ?? [...ITEM_TYPES];
        const rows: ConfigRow[] = types.map((type) => ({
            type,
            fields: RULE_FIELDS.map((field) => ({ field, resolved: loaded.rules.field(type, field) })).filter(
                (entry) => entry.resolved.value.level !== "optional"
            ),
            writes: WRITE_VERBS.map((verb) => ({ verb, resolved: loaded.rules.mayWrite(type, verb) })),
            notify: NOTIFY_ACTIONS.map((action) => ({
                action,
                resolved: resolveNotify(loaded.notifyLayers, { type, action }),
                editor: notifyForConfig({ loaded, type, action }),
            })),
        }));
        return okReply("config", { project, sources: loaded.sources, rows }, { diagnostics: loaded.problems });
    },

    async configSet(p, session) {
        const project = p.project ?? session.ctx.project;
        const loaded = await rulesForConfig(session, project);
        const lockedCells = new Set<string>();

        for (const type of ITEM_TYPES) {
            for (const action of NOTIFY_ACTIONS) {
                if (notifyForConfig({ loaded, type, action }).from === "config.repo") {
                    lockedCells.add(`${type}:${action}`);
                }
            }
        }

        const result = await setWorkNotifyConfig({
            ...p,
            ...(session.configPath !== undefined ? { configPath: session.configPath } : {}),
            dryRun: session.call.dryRun === true,
            projectExists: selectItems(session.ctx.db, { project, limit: 1 }).length > 0,
            lockedCells,
        });
        return result.ok
            ? okReply("configSet", { changed: result.changed, file: result.file }, { dryRun: session.call.dryRun })
            : failReply("configSet", [errorDiagnostic(result.code, result.problem)]);
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

    async pair(p, session) {
        const sync = syncOf(session, "pair");
        const found = itemOf(session, "pair", p.ref);

        if ("refused" in sync) {
            return sync.refused;
        }

        if ("refused" in found) {
            return found.refused;
        }

        const unknown = knownConnector(sync.deps, "pair", p.connector);

        if (unknown !== null) {
            return unknown;
        }

        if (session.call.dryRun === true) {
            return okReply("pair", {
                pairing: {
                    item: found.item.id,
                    connector: p.connector,
                    remoteKey: p.key,
                    born: "local",
                    origin: originFor("local"),
                    state: "pending",
                    updatedTs: sync.deps.now(),
                },
                push: { pushed: 0, held: 0, failed: 0, drift: 0, cursor: -1 },
            });
        }

        const pairing = pairItem(sync.deps, found.item.id, p.connector, p.key);
        const push = await pushPairing({ deps: sync.deps, item: found.item.id, connector: p.connector });
        return okReply("pair", { pairing, push });
    },

    async unpair(p, session) {
        const sync = syncOf(session, "unpair");
        const found = itemOf(session, "unpair", p.ref);

        if ("refused" in sync) {
            return sync.refused;
        }

        if ("refused" in found) {
            return found.refused;
        }

        if (session.call.dryRun === true) {
            return okReply("unpair", { removed: false });
        }

        return okReply("unpair", { removed: unpairItem(sync.deps, found.item.id, p.connector) });
    },

    async pull(p, session) {
        const sync = syncOf(session, "pull");

        if ("refused" in sync) {
            return sync.refused;
        }

        const unknown = knownConnector(sync.deps, "pull", p.connector);

        if (unknown !== null) {
            return unknown;
        }

        const project = p.project ?? session.ctx.project;
        if (session.call.dryRun === true) {
            return okReply(
                "pull",
                { made: [], updated: [], drift: [] },
                {
                    dryRun: true,
                    diagnostics: [
                        infoDiagnostic(
                            "PREVIEW",
                            `Would pull ${p.keys.length} item(s) from ${p.connector} into ${project}.`
                        ),
                    ],
                }
            );
        }

        const random = session.ctx.random ?? randomItemSuffix;
        const report = await pullRemote({ ...sync.deps, project, newId: () => newItemId(random) }, p.connector, p.keys);
        return okReply("pull", report);
    },

    async sync(p, session) {
        const sync = syncOf(session, "sync");

        if ("refused" in sync) {
            return sync.refused;
        }

        const preview = (message: string) =>
            okReply(
                "sync",
                {
                    pushed: 0,
                    held: 0,
                    failed: 0,
                    drift: 0,
                    cursor: -1,
                },
                { dryRun: true, diagnostics: [infoDiagnostic("PREVIEW", message)] }
            );

        if (p.release === undefined) {
            return session.call.dryRun === true
                ? preview("Would sync queued connector changes.")
                : okReply("sync", await runSyncOnce(sync.deps));
        }

        const found = itemOf(session, "sync", p.release);

        if ("refused" in found) {
            return found.refused;
        }

        return session.call.dryRun === true
            ? preview(`Would release held connector changes for ${found.item.id}.`)
            : okReply("sync", await releaseHeld(sync.deps, found.item.id));
    },

    async addMember(p, session) {
        return run(session, { verb: "add-member", refs: p.refs, to: p.to });
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
