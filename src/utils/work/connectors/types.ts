/**
 * A connector links a local item to an item outside (a tracker task, a Reminders entry). The local store works with
 * no connector at all; a pairing is one row on a local item. A new connector is one folder and one row of the table.
 */
import type { ZodType } from "zod";
import type { Item, ItemId } from "../model/item";
import type { ItemState, ItemType, Severity } from "../model/vocab";

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
    updatedTs: string;
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
}

export type PushResult = { ok: true; remoteKey: string } | { ok: false; error: string };

/** One outside item as a connector reads it. */
export interface RemoteItem {
    remoteKey: string;
    title?: string;
    body?: string;
    type?: ItemType;
    state?: ItemState;
    severity?: Severity;
    tags?: string[];
    labels?: string[];
}

export interface ConnectorContext<S = unknown> {
    settings: S;
    project: string;
    /** The machine part of the label (`machine.prefix` of the config). */
    machinePrefix: string;
}

export interface Connector<S = unknown> {
    readonly id: string;
    readonly settings: ZodType<S>;
    readonly can: { create: boolean; pull: boolean; labels: boolean; comments: boolean; parents: boolean };
    status(ctx: ConnectorContext<S>): Promise<{ ok: boolean; detail: string }>;
    push(intents: readonly PushIntent[], ctx: ConnectorContext<S>): Promise<PushResult[]>;
    pull(ask: { remoteKeys: readonly string[] }, ctx: ConnectorContext<S>): Promise<RemoteItem[]>;
}

/** `gt/pm/{machine}{project}/{id}`: what a person in the tracker sees, and how a lost pairing is found again. */
export function pairingLabelFor(template: string, values: { machine: string; project: string; id: string }): string {
    return template
        .replace("{machine}", values.machine)
        .replace("{project}", values.project)
        .replace("{id}", values.id);
}

export const DEFAULT_LABEL_TEMPLATE = "gt/pm/{machine}{project}/{id}";
