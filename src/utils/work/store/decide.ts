import type { Diagnostic, NextAction } from "@genesiscz/utils/output/reply";
import { errorDiagnostic, infoDiagnostic, warningDiagnostic } from "@genesiscz/utils/output/reply";
import type { ContextStamp, NewChange } from "../model/change";
import type { Actor, Item, ItemFields, ItemId } from "../model/item";
import { asItemId } from "../model/item";
import type { CreatedPayload, ItemPatch } from "../model/payloads";
import type { ItemState, ItemType, LinkKind, LogResult, Severity } from "../model/vocab";
import { isOpenState } from "../model/vocab";
import type { DeliveryReceipt, LegacyAction } from "../ports";
import type { Membership, Resolved, StoreView } from "./view";

export type WorkCommand =
    | {
          verb: "spot";
          title: string;
          type: ItemType;
          fields: ItemFields;
          severity?: Severity;
          during?: string;
          project?: string;
      }
    | {
          verb: "add";
          title: string;
          type: ItemType;
          body?: string;
          acceptance?: string;
          parent?: string;
          under?: string;
          for?: string;
          tags?: string[];
          fields?: ItemFields;
          project?: string;
      }
    | {
          verb: "edit";
          ref: string;
          type?: ItemType;
          severity?: Severity;
          parent?: string;
          for?: string;
          title?: string;
          fields?: ItemFields;
          /** Pair a spotted item with the task or handoff it was seen in (replaces an earlier pairing). */
          during?: string;
      }
    | { verb: "link" | "unlink"; ref: string; kind: LinkKind; to: string }
    | { verb: "accept"; refs: string[]; type?: ItemType; severity?: Severity }
    | { verb: "drop"; refs: string[]; why: string }
    | { verb: "finish"; ref: string; proof: string; commits?: string[] }
    | { verb: "log"; ref: string; result: LogResult; note?: string; measured?: string }
    | { verb: "comment"; ref: string; text: string }
    | { verb: "reopen"; ref: string; why: string }
    | { verb: "delivered"; ref: string; key: string; receipt: DeliveryReceipt }
    | { verb: "handoff"; title: string; from: string[]; target?: string; body?: string };

export type WorkVerb = WorkCommand["verb"];

export interface WriteEnv {
    actor: Actor;
    now: string;
    /** The project of a new item when the command names none: the folder name of the main checkout. */
    project: string;
    newId: () => ItemId;
    request?: string;
    stamp?: ContextStamp;
    /** The sessions whose live claims a spotted item may pair with: the caller's own, then its lead's. */
    lineage: string[];
}

export type Decision =
    | {
          ok: true;
          changes: NewChange[];
          /** Writes for the old handoff log; the caller runs them after the store's transaction commits. */
          legacy: LegacyAction[];
          /** The items the reply should show after the write. */
          items: ItemId[];
          diagnostics: Diagnostic[];
          next: NextAction[];
          noop?: boolean;
      }
    | { ok: false; diagnostics: Diagnostic[]; next: NextAction[] };

/** The transitions of the verbs (spec: "States"). */
const TRANSITIONS: Record<
    "accept" | "claim" | "release" | "finish" | "drop" | "reopen",
    Partial<Record<ItemState, ItemState>>
> = {
    accept: { spotted: "open" },
    claim: { open: "active", reopened: "active" },
    release: { active: "open" },
    finish: { open: "done", active: "done", reopened: "done", spotted: "done" },
    drop: { spotted: "dropped", open: "dropped", active: "dropped", reopened: "dropped" },
    reopen: { done: "reopened", dropped: "reopened" },
};

/** Built-in field rules of P1: what `spot` recommends. P3 replaces this table with the rules of the config. */
const SPOT_RECOMMENDED: { field: keyof ItemFields; flag: string; measure: string }[] = [
    { field: "where", flag: "--where", measure: "the file and line, or the screen, where you saw it (path:line)" },
    { field: "why", flag: "--why", measure: "why it is wrong or why it matters, in one sentence" },
    { field: "userSees", flag: "--user-sees", measure: "what a user sees because of it, in one sentence" },
];

function fail(code: string, message: string, field?: string): Decision {
    return { ok: false, diagnostics: [errorDiagnostic(code, message, field)], next: [] };
}

function notFound(ref: string): Decision {
    return {
        ok: false,
        diagnostics: [errorDiagnostic("NOT_FOUND", `No item ${ref}. Use an id (w_…, h_…) or <handoff>:<slot>.`)],
        next: [{ do: "find the item", call: { method: "list", params: {} } }],
    };
}

function base(
    env: WriteEnv,
    item: ItemId
): Pick<NewChange, "v" | "ts" | "item" | "actor" | "origin" | "request" | "stamp"> {
    return {
        v: 1,
        ts: env.now,
        item,
        actor: env.actor,
        origin: { via: "local" },
        ...(env.request !== undefined ? { request: env.request } : {}),
        ...(env.stamp !== undefined ? { stamp: env.stamp } : {}),
    };
}

/** The slots of the old log that hold an item: the one the ref named first, then the others. */
function slotsOf(view: StoreView, resolved: Resolved): Membership[] {
    const all = view.memberships(resolved.item.id);

    if (resolved.via === undefined) {
        return all;
    }

    const named = resolved.via;
    return [named, ...all.filter((m) => !(m.handoff === named.handoff && m.slot === named.slot))];
}

function move(
    env: WriteEnv,
    item: Item,
    to: ItemState,
    extra: { why?: string; proof?: { text: string; commits?: string[] } } = {}
): NewChange {
    return { ...base(env, item.id), kind: "moved", payload: { from: item.state, to, ...extra } };
}

function cleanFields(fields: ItemFields): ItemFields {
    const out: ItemFields = {};

    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
            continue;
        }

        if (typeof value === "string" && value.trim().length === 0) {
            continue;
        }

        (out as Record<string, unknown>)[key] = value;
    }

    return out;
}

/** The handoff a spotted item belongs to: --during, else the one live claim of the caller or its lead. */
function pairSpot(
    view: StoreView,
    env: WriteEnv,
    during: string | undefined
): { to: ItemId | null; diagnostics: Diagnostic[]; next: NextAction[] } {
    if (during !== undefined) {
        const resolved = view.resolve(during);

        if (resolved === null) {
            return {
                to: null,
                diagnostics: [errorDiagnostic("NOT_FOUND", `No item ${during} for --during.`, "during")],
                next: [],
            };
        }

        return { to: resolved.item.id, diagnostics: [], next: [] };
    }

    for (const session of env.lineage) {
        const live = view
            .claims({ sessionIds: [session], active: true })
            .map((claim) => view.item(claim.item))
            .filter((item): item is Item => item !== null && isOpenState(item.state));
        const unique = [...new Map(live.map((item) => [item.id, item])).values()];

        if (unique.length === 1) {
            return { to: unique[0].id, diagnostics: [], next: [] };
        }

        if (unique.length > 1) {
            return {
                to: null,
                diagnostics: [
                    warningDiagnostic(
                        "CONTEXT_AMBIGUOUS",
                        `The caller holds ${unique.length} live claims (${unique.map((i) => i.id).join(", ")}); the item stays in the inbox.`,
                        "during"
                    ),
                ],
                next: unique.map((item) => ({
                    do: `pair it with ${item.id} (${item.title})`,
                    call: { method: "edit", params: { during: item.id } },
                })),
            };
        }
    }

    return {
        to: null,
        diagnostics: [
            warningDiagnostic(
                "CONTEXT_MISSING",
                "No live claim of this session or its lead was found; the item stays in the project inbox. Pass --during <ref> to pair it.",
                "during"
            ),
        ],
        next: [{ do: "pair it with the task you worked on", call: { method: "spot", params: { during: "<ref>" } } }],
    };
}

function decideSpot(cmd: Extract<WorkCommand, { verb: "spot" }>, view: StoreView, env: WriteEnv): Decision {
    const title = cmd.title.trim();

    if (title.length === 0) {
        return fail("FIELD_REQUIRED", "A title is required.", "title");
    }

    const id = env.newId();
    const fields = cleanFields(cmd.fields);
    const payload: CreatedPayload = {
        type: cmd.type,
        state: "spotted",
        project: cmd.project ?? env.project,
        title,
        tags: [],
        fields,
        ...(cmd.severity !== undefined ? { severity: cmd.severity } : {}),
    };
    const changes: NewChange[] = [{ ...base(env, id), kind: "created", payload }];
    const pairing = pairSpot(view, env, cmd.during);

    if (pairing.diagnostics.some((d) => d.severity === "error")) {
        return { ok: false, diagnostics: pairing.diagnostics, next: pairing.next };
    }

    if (pairing.to !== null) {
        changes.push({ ...base(env, id), kind: "linked", payload: { kind: "spotted-in", to: pairing.to } });
    }

    const diagnostics: Diagnostic[] = [...pairing.diagnostics];
    const next: NextAction[] = pairing.next.map((n) =>
        n.call ? { ...n, call: { method: "edit", params: { ...n.call.params, ref: id } } } : n
    );

    for (const rule of SPOT_RECOMMENDED) {
        if (fields[rule.field] === undefined) {
            diagnostics.push(
                warningDiagnostic("FIELD_RECOMMENDED", `${rule.flag} is recommended: ${rule.measure}.`, rule.field)
            );
            next.push({
                do: `add ${rule.flag}`,
                call: { method: "edit", params: { ref: id, [rule.field]: "<text>" } },
            });
        }
    }

    return { ok: true, changes, legacy: [], items: [id], diagnostics, next };
}

function decideAdd(cmd: Extract<WorkCommand, { verb: "add" }>, view: StoreView, env: WriteEnv): Decision {
    const title = cmd.title.trim();

    if (title.length === 0) {
        return fail("FIELD_REQUIRED", "A title is required.", "title");
    }

    const id = env.newId();
    const payload: CreatedPayload = {
        type: cmd.type,
        state: "open",
        project: cmd.project ?? env.project,
        title,
        tags: cmd.tags ?? [],
        fields: cleanFields(cmd.fields ?? {}),
        ...(cmd.body !== undefined ? { body: cmd.body } : {}),
        ...(cmd.acceptance !== undefined ? { acceptance: cmd.acceptance } : {}),
        ...(cmd.for !== undefined ? { for: cmd.for } : {}),
    };
    const changes: NewChange[] = [{ ...base(env, id), kind: "created", payload }];
    const legacy: LegacyAction[] = [];

    if (cmd.parent !== undefined) {
        const parent = view.resolve(cmd.parent);

        if (parent === null) {
            return notFound(cmd.parent);
        }

        changes.push({ ...base(env, id), kind: "linked", payload: { kind: "parent", to: parent.item.id } });
    }

    if (cmd.under !== undefined) {
        const handoff = view.resolve(cmd.under);

        if (handoff === null) {
            return notFound(cmd.under);
        }

        if (handoff.item.type !== "handoff") {
            return fail("NOT_A_HANDOFF", `${cmd.under} is a ${handoff.item.type}, not a handoff.`, "under");
        }

        // The old log holds a handoff's tasks while shadow mode lasts; its event carries the item id, so the hook
        // adds the member reference and never makes a second item.
        legacy.push({
            action: "add_tasks",
            handoff: handoff.item.id,
            tasks: [{ text: title, ...(cmd.acceptance ? { acceptanceCriteria: cmd.acceptance } : {}), item: id }],
        });
    }

    return { ok: true, changes, legacy, items: [id], diagnostics: [], next: [] };
}

function decideEdit(cmd: Extract<WorkCommand, { verb: "edit" }>, view: StoreView, env: WriteEnv): Decision {
    const resolved = view.resolve(cmd.ref);

    if (resolved === null) {
        return notFound(cmd.ref);
    }

    const item = resolved.item;
    const set: ItemPatch = {};
    const changes: NewChange[] = [];
    const legacy: LegacyAction[] = [];
    const slots = slotsOf(view, resolved);

    if (cmd.type !== undefined && cmd.type !== item.type) {
        if (item.type === "handoff" || cmd.type === "handoff") {
            return fail("TYPE_LOCKED", "A handoff stays a handoff; make a new item instead.", "type");
        }

        set.type = cmd.type;
    }

    if (cmd.severity !== undefined && cmd.severity !== item.severity) {
        set.severity = cmd.severity;
    }

    if (cmd.for !== undefined && cmd.for !== item.for) {
        set.for = cmd.for;
    }

    if (cmd.fields !== undefined) {
        const fields = cleanFields(cmd.fields);

        if (Object.keys(fields).length > 0) {
            set.fields = fields;
        }
    }

    if (cmd.title !== undefined && cmd.title.trim() !== item.title) {
        if (slots.length > 0) {
            // The old log is the writer of a handoff task's text until the switch.
            for (const slot of slots) {
                legacy.push({
                    action: "modify_task",
                    handoff: slot.handoff,
                    taskId: slot.slot,
                    text: cmd.title.trim(),
                });
            }
        } else if (item.type === "handoff") {
            return fail(
                "LEGACY_OWNED",
                "The title of a handoff changes through handoff_action modify_handoff until the switch (P6).",
                "title"
            );
        } else {
            set.title = cmd.title.trim();
        }
    }

    if (Object.keys(set).length > 0) {
        changes.push({ ...base(env, item.id), kind: "edited", payload: { set } });
    }

    if (cmd.parent !== undefined) {
        const parent = view.resolve(cmd.parent);

        if (parent === null) {
            return notFound(cmd.parent);
        }

        if (parent.item.id === item.id) {
            return fail("PARENT_CYCLE", "An item cannot be its own parent.", "parent");
        }

        // Walk up from the new parent: the item must not be an ancestor of it.
        let cursor: ItemId | null = parent.item.id;
        const seen = new Set<string>();

        while (cursor !== null && !seen.has(cursor)) {
            if (cursor === item.id) {
                return fail(
                    "PARENT_CYCLE",
                    `${parent.item.id} is under ${item.id}; that would make a cycle.`,
                    "parent"
                );
            }

            seen.add(cursor);
            cursor = view.parentOf(cursor);
        }

        const current = view.parentOf(item.id);

        if (current !== parent.item.id) {
            if (current !== null) {
                changes.push({ ...base(env, item.id), kind: "unlinked", payload: { kind: "parent", to: current } });
            }

            changes.push({ ...base(env, item.id), kind: "linked", payload: { kind: "parent", to: parent.item.id } });
        }
    }

    if (cmd.during !== undefined) {
        const during = view.resolve(cmd.during);

        if (during === null) {
            return notFound(cmd.during);
        }

        const current = view.refsFrom(item.id).filter((ref) => ref.kind === "spotted-in");

        if (!current.some((ref) => ref.to === during.item.id)) {
            for (const ref of current) {
                changes.push({ ...base(env, item.id), kind: "unlinked", payload: { kind: "spotted-in", to: ref.to } });
            }

            changes.push({
                ...base(env, item.id),
                kind: "linked",
                payload: { kind: "spotted-in", to: during.item.id },
            });
        }
    }

    const noop = changes.length === 0 && legacy.length === 0;
    return { ok: true, changes, legacy, items: [item.id], diagnostics: [], next: [], ...(noop ? { noop } : {}) };
}

function decideLink(cmd: Extract<WorkCommand, { verb: "link" | "unlink" }>, view: StoreView, env: WriteEnv): Decision {
    const from = view.resolve(cmd.ref);

    if (from === null) {
        return notFound(cmd.ref);
    }

    const to = view.resolve(cmd.to);

    if (to === null) {
        return notFound(cmd.to);
    }

    if (from.item.id === to.item.id) {
        return fail("SELF_LINK", "An item cannot point at itself.");
    }

    const exists = view.refsFrom(from.item.id).some((ref) => ref.kind === cmd.kind && ref.to === to.item.id);

    if (cmd.verb === "link" ? exists : !exists) {
        return { ok: true, changes: [], legacy: [], items: [from.item.id], diagnostics: [], next: [], noop: true };
    }

    return {
        ok: true,
        changes: [
            {
                ...base(env, from.item.id),
                kind: cmd.verb === "link" ? "linked" : "unlinked",
                payload: { kind: cmd.kind, to: to.item.id },
            },
        ],
        legacy: [],
        items: [from.item.id],
        diagnostics: [],
        next: [],
    };
}

function decideAccept(cmd: Extract<WorkCommand, { verb: "accept" }>, view: StoreView, env: WriteEnv): Decision {
    const changes: NewChange[] = [];
    const items: ItemId[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const ref of cmd.refs) {
        const resolved = view.resolve(ref);

        if (resolved === null) {
            return notFound(ref);
        }

        const item = resolved.item;
        items.push(item.id);
        const set: ItemPatch = {};

        if (cmd.type !== undefined && cmd.type !== item.type) {
            set.type = cmd.type;
        }

        if (cmd.severity !== undefined && cmd.severity !== item.severity) {
            set.severity = cmd.severity;
        }

        if (Object.keys(set).length > 0) {
            changes.push({ ...base(env, item.id), kind: "edited", payload: { set } });
        }

        const to = TRANSITIONS.accept[item.state];

        if (to === undefined) {
            diagnostics.push(
                infoDiagnostic("NOOP", `${item.id} is ${item.state}; accept changes only a spotted item.`)
            );
            continue;
        }

        changes.push(move(env, item, to));
    }

    return {
        ok: true,
        changes,
        legacy: [],
        items,
        diagnostics,
        next: [],
        ...(changes.length === 0 ? { noop: true } : {}),
    };
}

function decideDrop(cmd: Extract<WorkCommand, { verb: "drop" }>, view: StoreView, env: WriteEnv): Decision {
    if (cmd.why.trim().length === 0) {
        return fail("FIELD_REQUIRED", "--why is required: say why nobody will do it.", "why");
    }

    const changes: NewChange[] = [];
    const legacy: LegacyAction[] = [];
    const items: ItemId[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const ref of cmd.refs) {
        const resolved = view.resolve(ref);

        if (resolved === null) {
            return notFound(ref);
        }

        const item = resolved.item;
        items.push(item.id);
        const to = TRANSITIONS.drop[item.state];

        if (to === undefined) {
            diagnostics.push(infoDiagnostic("NOOP", `${item.id} is ${item.state} already.`));
            continue;
        }

        const slots = slotsOf(view, resolved);

        if (slots.length > 0) {
            for (const slot of slots) {
                legacy.push({ action: "deny_task", handoff: slot.handoff, taskId: slot.slot, reason: cmd.why });
            }

            continue;
        }

        if (item.type === "handoff") {
            return fail(
                "LEGACY_OWNED",
                "A handoff is cancelled through handoff_action cancel_handoff until the switch (P6)."
            );
        }

        changes.push(move(env, item, to, { why: cmd.why }));
    }

    const noop = changes.length === 0 && legacy.length === 0;
    return { ok: true, changes, legacy, items, diagnostics, next: [], ...(noop ? { noop } : {}) };
}

function decideFinish(cmd: Extract<WorkCommand, { verb: "finish" }>, view: StoreView, env: WriteEnv): Decision {
    if (cmd.proof.trim().length === 0) {
        return fail("FIELD_REQUIRED", "--proof is required: the command, where it ran, the commit.", "proof");
    }

    const resolved = view.resolve(cmd.ref);

    if (resolved === null) {
        return notFound(cmd.ref);
    }

    const item = resolved.item;

    if (item.state === "done") {
        return {
            ok: true,
            changes: [],
            legacy: [],
            items: [item.id],
            diagnostics: [infoDiagnostic("NOOP", `${item.id} is done already.`)],
            next: [],
            noop: true,
        };
    }

    const to = TRANSITIONS.finish[item.state];

    if (to === undefined) {
        return {
            ok: false,
            diagnostics: [errorDiagnostic("BAD_TRANSITION", `${item.id} is ${item.state}; reopen it first.`)],
            next: [{ do: "reopen it", call: { method: "reopen", params: { ref: item.id, why: "<text>" } } }],
        };
    }

    const changes: NewChange[] = [];
    const legacy: LegacyAction[] = [];

    for (const commit of cmd.commits ?? []) {
        changes.push({
            ...base(env, item.id),
            kind: "pointed",
            payload: { pointer: { kind: "commit", target: commit } },
        });
    }

    const slots = slotsOf(view, resolved);

    if (slots.length > 0) {
        for (const slot of slots) {
            legacy.push({
                action: "check_task",
                handoff: slot.handoff,
                taskId: slot.slot,
                proof: { answer: cmd.proof, ...(cmd.commits?.length ? { commitIds: cmd.commits } : {}) },
            });
        }
    } else if (item.type === "handoff") {
        return fail(
            "LEGACY_OWNED",
            "A handoff is finished through handoff_action finish_handoff until the switch (P6)."
        );
    } else {
        changes.push(
            move(env, item, to, {
                proof: { text: cmd.proof, ...(cmd.commits?.length ? { commits: cmd.commits } : {}) },
            })
        );
    }

    return { ok: true, changes, legacy, items: [item.id], diagnostics: [], next: [] };
}

function decideLog(cmd: Extract<WorkCommand, { verb: "log" }>, view: StoreView, env: WriteEnv): Decision {
    const resolved = view.resolve(cmd.ref);

    if (resolved === null) {
        return notFound(cmd.ref);
    }

    const diagnostics: Diagnostic[] = [];

    if (cmd.result === "limit" && cmd.measured === undefined) {
        diagnostics.push(
            warningDiagnostic(
                "FIELD_RECOMMENDED",
                '--measured is recommended for a limit: "<number, unit, target>".',
                "measured"
            )
        );
    }

    const changes: NewChange[] = [
        {
            ...base(env, resolved.item.id),
            kind: "logged",
            payload: {
                result: cmd.result,
                ...(cmd.note !== undefined ? { note: cmd.note } : {}),
                ...(cmd.measured !== undefined ? { measured: cmd.measured } : {}),
            },
        },
    ];

    if (cmd.measured !== undefined) {
        changes.push({
            ...base(env, resolved.item.id),
            kind: "edited",
            payload: { set: { fields: { measured: cmd.measured } } },
        });
    }

    return { ok: true, changes, legacy: [], items: [resolved.item.id], diagnostics, next: [] };
}

function decideComment(cmd: Extract<WorkCommand, { verb: "comment" }>, view: StoreView, env: WriteEnv): Decision {
    const resolved = view.resolve(cmd.ref);

    if (resolved === null) {
        return notFound(cmd.ref);
    }

    const slots = slotsOf(view, resolved);

    if (slots.length > 0) {
        const slot = slots[0];
        return {
            ok: true,
            changes: [],
            legacy: [{ action: "comment", handoff: slot.handoff, text: `[${slot.slot}] ${cmd.text}` }],
            items: [resolved.item.id],
            diagnostics: [],
            next: [],
        };
    }

    if (resolved.item.type === "handoff") {
        return {
            ok: true,
            changes: [],
            legacy: [{ action: "comment", handoff: resolved.item.id, text: cmd.text }],
            items: [resolved.item.id],
            diagnostics: [],
            next: [],
        };
    }

    return {
        ok: true,
        changes: [{ ...base(env, resolved.item.id), kind: "commented", payload: { text: cmd.text } }],
        legacy: [],
        items: [resolved.item.id],
        diagnostics: [],
        next: [],
    };
}

/** The first transaction of a reopen: the reason and the move. The delivery and its receipt come after. */
function decideReopen(cmd: Extract<WorkCommand, { verb: "reopen" }>, view: StoreView, env: WriteEnv): Decision {
    if (cmd.why.trim().length === 0) {
        return fail("FIELD_REQUIRED", "--why is required: what is still wrong, with the evidence.", "why");
    }

    const resolved = view.resolve(cmd.ref);

    if (resolved === null) {
        return notFound(cmd.ref);
    }

    const item = resolved.item;
    const to = TRANSITIONS.reopen[item.state];

    if (to === undefined) {
        return {
            ok: false,
            diagnostics: [
                errorDiagnostic("BAD_TRANSITION", `${item.id} is ${item.state}; only a done or dropped item reopens.`),
            ],
            next: [
                { do: "comment on it instead", call: { method: "comment", params: { ref: item.id, text: cmd.why } } },
            ],
        };
    }

    const slots = slotsOf(view, resolved);

    if (slots.length > 0) {
        const legacy: LegacyAction[] = [];

        for (const slot of slots) {
            legacy.push(
                item.state === "done"
                    ? { action: "uncheck_task", handoff: slot.handoff, taskId: slot.slot }
                    : { action: "undeny_task", handoff: slot.handoff, taskId: slot.slot }
            );
        }

        legacy.push({ action: "comment", handoff: slots[0].handoff, text: `[${slots[0].slot}] reopened: ${cmd.why}` });
        return { ok: true, changes: [], legacy, items: [item.id], diagnostics: [], next: [] };
    }

    if (item.type === "handoff") {
        return fail("LEGACY_OWNED", "A handoff reopens through handoff_action reopen_handoff until the switch (P6).");
    }

    return {
        ok: true,
        changes: [
            { ...base(env, item.id), kind: "commented", payload: { text: `reopened: ${cmd.why}` } },
            move(env, item, to, { why: cmd.why }),
        ],
        legacy: [],
        items: [item.id],
        diagnostics: [],
        next: [],
    };
}

function decideDelivered(cmd: Extract<WorkCommand, { verb: "delivered" }>, view: StoreView, env: WriteEnv): Decision {
    const resolved = view.resolve(cmd.ref);

    if (resolved === null) {
        return notFound(cmd.ref);
    }

    return {
        ok: true,
        changes: [
            { ...base(env, resolved.item.id), kind: "delivered", payload: { key: cmd.key, receipt: cmd.receipt } },
        ],
        legacy: [],
        items: [resolved.item.id],
        diagnostics: [],
        next: [],
    };
}

/**
 * `handoff --from`: accept the items here; the old log gets the post, and each of its tasks carries the item id, so
 * the hook (or a later backfill) adds the member references and makes no second item.
 */
function decideHandoff(cmd: Extract<WorkCommand, { verb: "handoff" }>, view: StoreView, env: WriteEnv): Decision {
    const title = cmd.title.trim();

    if (title.length === 0) {
        return fail("FIELD_REQUIRED", "A title is required.", "title");
    }

    if (cmd.from.length === 0) {
        return fail("FIELD_REQUIRED", "--from needs at least one item.", "from");
    }

    const changes: NewChange[] = [];
    const tasks: { text: string; acceptanceCriteria?: string; item: string }[] = [];
    const items: ItemId[] = [];
    const projects = new Set<string>();

    for (const ref of cmd.from) {
        const resolved = view.resolve(ref);

        if (resolved === null) {
            return notFound(ref);
        }

        const item = resolved.item;

        if (!isOpenState(item.state)) {
            return fail("BAD_TRANSITION", `${item.id} is ${item.state}; reopen it before it goes into a handoff.`);
        }

        if (item.type === "handoff") {
            return fail("NOT_WORK", `${item.id} is a handoff; a handoff holds work items.`);
        }

        if (items.includes(item.id)) {
            continue;
        }

        items.push(item.id);
        projects.add(item.project);
        const accept = TRANSITIONS.accept[item.state];

        if (accept !== undefined) {
            changes.push(move(env, item, accept));
        }

        tasks.push({
            text: item.title,
            ...(item.acceptance !== undefined ? { acceptanceCriteria: item.acceptance } : {}),
            item: item.id,
        });
    }

    const project = projects.size === 1 ? [...projects][0] : env.project;
    const legacy: LegacyAction[] = [
        {
            action: "post",
            title,
            project,
            tasks,
            ...(cmd.body !== undefined ? { description: cmd.body } : {}),
            ...(cmd.target !== undefined ? { target: { agent: cmd.target } } : {}),
        },
    ];
    return { ok: true, changes, legacy, items, diagnostics: [], next: [] };
}

/** Pure. The one judge of every write: transitions, field rules, the parent rule, the routing to the old log. */
export function decide(command: WorkCommand, view: StoreView, env: WriteEnv): Decision {
    switch (command.verb) {
        case "spot":
            return decideSpot(command, view, env);
        case "add":
            return decideAdd(command, view, env);
        case "edit":
            return decideEdit(command, view, env);
        case "link":
        case "unlink":
            return decideLink(command, view, env);
        case "accept":
            return decideAccept(command, view, env);
        case "drop":
            return decideDrop(command, view, env);
        case "finish":
            return decideFinish(command, view, env);
        case "log":
            return decideLog(command, view, env);
        case "comment":
            return decideComment(command, view, env);
        case "reopen":
            return decideReopen(command, view, env);
        case "delivered":
            return decideDelivered(command, view, env);
        case "handoff":
            return decideHandoff(command, view, env);
    }
}

export function newItemId(random: () => string): ItemId {
    return asItemId(`w_${random()}`);
}
