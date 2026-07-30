import type { CatalogEntry } from "../catalog";
import type { AiConfigStore } from "../config/AiConfigStore";
import type { AccountEntry, TaskName } from "../config/schema";
import type { ProviderBinding, ProviderPlugin } from "../providers/plugin-types";

/**
 * A model the static catalog does not list.
 *
 * Not an error: live providers serve models the curated list has not caught up
 * with, and refusing them would make the catalog a gate rather than a reference.
 * The flag exists so callers know a context window or a price is unavailable
 * rather than zero.
 */
export interface UnlistedModel {
    id: string;
    /** Plugin id of the account this model was resolved against. */
    provider: string;
    unlisted: true;
}

export type ResolvedModel = CatalogEntry | UnlistedModel;

export interface ResolveOptions {
    task?: TaskName;
    /** Tool name, for `defaults.app.<app>.<task>` overrides. */
    app?: string;
    /** An already-loaded config store; tests and batch resolution pass one to skip the disk read. */
    store?: AiConfigStore;
    /** Handed to the plugin's `bind()` — the seam github-copilot uses for its own transport. */
    fetch?: typeof fetch;
}

/** Everything needed to make a call, with the account that will be billed named. */
export interface ResolvedBinding {
    account: AccountEntry;
    plugin: ProviderPlugin;
    binding: ProviderBinding;
    model: ResolvedModel;
    /** Which rung of the ladder produced this, e.g. `defaults.task.summarize`. For logs and `-v`. */
    via: string;
}

/** The same decision without binding a provider: no credentials read, no network. */
export interface ResolvedTarget {
    account: AccountEntry;
    plugin: ProviderPlugin;
    model: ResolvedModel;
    via: string;
}

export function isUnlisted(model: ResolvedModel): model is UnlistedModel {
    return "unlisted" in model;
}
