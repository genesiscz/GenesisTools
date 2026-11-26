/**
 * A connector links a local item to an item outside (a tracker task, a Reminders entry). The local store works with
 * no connector at all; a pairing is one row on a local item. A new connector is one folder and one row of the table.
 */
import type { ZodType } from "zod";
import type { Item, ItemId } from "../model/item";
import type { ItemState, ItemType, LinkKind, Severity } from "../model/vocab";

export const SYNCED_FACTS = ["title", "body", "type", "parent", "tags", "state", "severity"] as const;
export type SyncedFact = (typeof SYNCED_FACTS)[number];

export const PAIRING_STATES = ["in-sync", "pending", "held", "drift", "failed"] as const;
export type PairingState = (typeof PAIRING_STATES)[number];

/** The first words of a stored drift note identify the side that changed. */
export const DRIFT_NOTE_PREFIX = {
    local: "changed here, owned outside:",
    remote: "changed outside, owned here:",
} as const;

export interface Pairing {
    item: ItemId;
    connector: string;
    remoteKey: string;
    /** The side that made the item: its title and text travel from there. */
    born: "local" | "remote";
    /** The side that owns each fact. A fact changes only on its owner's side; the other side's change is drift. */
    origin: Record<SyncedFact, "local" | "remote">;
    state: PairingState;
    /** Why the pairing is held, drifted or failed. */
    note?: string;
    /** What this side last wrote outside for each fact, the base of the check before the next push. */
    sent?: SentFacts;
    updatedTs: string;
}

/** A fact's value as the connector writes it outside (its own words: the outside type, the cut title). */
export type SentFacts = Partial<Record<SyncedFact, string>>;

/** A fact that changed outside since this side last wrote it, so a push left it as it is. */
export interface FactChangedOutside {
    fact: SyncedFact;
    outside: string;
    here: string;
}

/** Who owns which fact, by the side that made the item (spec P5 decision 3). */
export function originFor(born: Pairing["born"]): Pairing["origin"] {
    const remote = born === "remote";
    return {
        title: remote ? "remote" : "local",
        body: remote ? "remote" : "local",
        type: remote ? "remote" : "local",
        parent: remote ? "remote" : "local",
        tags: remote ? "remote" : "local",
        state: "local",
        severity: "local",
    };
}

/** What a push carries: the item as it is now, its pairing (none when the outside item is still to be made). */
export interface PushIntent {
    item: Item;
    pairing: Pairing | null;
    /** The labels the outside item carries: the local id and each container that holds it. */
    labels: string[];
    /** The outside key of the item's parent on this connector; absent when it has none or the parent is not made yet. */
    parentKey?: string | null;
    /** The item's own links to items this connector already made outside. */
    links?: { kind: LinkKind; remoteKey: string }[];
    /** Facts to write even when they changed outside (`sync --resolve <id> --take ours`). */
    force?: readonly SyncedFact[];
}

export type PushResult =
    | {
          ok: true;
          remoteKey: string;
          /** The facts now equal on both sides, as written outside; absent from a connector that does not check. */
          sent?: SentFacts;
          /** Facts left as they are because they changed outside since the last push. */
          changedOutside?: FactChangedOutside[];
      }
    | { ok: false; error: string; remoteKey?: string; sent?: SentFacts; changedOutside?: FactChangedOutside[] };

/** One outside item as a connector reads it. */
export interface RemoteItem {
    remoteKey: string;
    title?: string;
    body?: string;
    type?: ItemType;
    state?: ItemState;
    /** Native status when several local states share one remote representation. */
    status?: string;
    severity?: Severity;
    tags?: string[];
    labels?: string[];
}

export interface ConnectorContext<S = unknown> {
    settings: S;
    project: string;
    /** The machine part of the label (`machine.prefix` of the config). */
    machinePrefix: string;
    /**
     * Renews the sync's lease during a long push (a connector that waits out a rate limit calls it before each
     * wait); false when the lease is lost, so the connector stops waiting.
     */
    keepAlive?: () => boolean;
}

export interface Connector<S = unknown> {
    readonly id: string;
    readonly settings: ZodType<S>;
    readonly can: {
        create: boolean;
        pull: boolean;
        labels: boolean;
        comments: boolean;
        parents: boolean;
        links: boolean;
    };
    status(ctx: ConnectorContext<S>): Promise<{ ok: boolean; detail: string }>;
    push(intents: readonly PushIntent[], ctx: ConnectorContext<S>): Promise<PushResult[]>;
    pull(ask: { remoteKeys: readonly string[] }, ctx: ConnectorContext<S>): Promise<RemoteItem[]>;
    /** Compare a decoded remote state against the representation this connector sends. */
    stateMatches?(remote: RemoteItem, local: ItemState): boolean;
}

/** `gt/pm/{machine}{project}/{id}`: what a person in the tracker sees, and how a lost pairing is found again. */
export function pairingLabelFor(template: string, values: { machine: string; project: string; id: string }): string {
    return template.replaceAll(/\{(machine|project|id)\}/g, (token) => {
        switch (token) {
            case "{machine}":
                return values.machine;
            case "{project}":
                return values.project;
            default:
                return values.id;
        }
    });
}

export const DEFAULT_LABEL_TEMPLATE = "gt/pm/{machine}{project}/{id}";
