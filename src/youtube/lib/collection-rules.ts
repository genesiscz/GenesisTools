import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { CollectionRecord } from "@app/youtube/lib/db.types";

export interface WatchedRule {
    type: "watched";
    /** Look-back window; 1..365 whole days. */
    sinceDays: number;
}

/** Discriminated union — extend with new rule types here, never ad-hoc JSON. */
export type CollectionRule = WatchedRule;

export function parseCollectionRule(raw: unknown): CollectionRule | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const candidate = raw as { type?: unknown; sinceDays?: unknown };

    if (candidate.type !== "watched") {
        return null;
    }

    const sinceDays = candidate.sinceDays;

    if (typeof sinceDays !== "number" || !Number.isFinite(sinceDays) || sinceDays <= 0 || sinceDays > 365) {
        return null;
    }

    return { type: "watched", sinceDays: Math.floor(sinceDays) };
}

export function ruleCutoffIso(rule: CollectionRule, now: Date = new Date()): string {
    return new Date(now.getTime() - rule.sinceDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Manual → membership rows; dynamic → rule over the owner's watch history. Broken rules resolve empty (never throw at read time). */
export function resolveCollectionVideoIds(db: YoutubeDatabase, collection: CollectionRecord): string[] {
    if (collection.kind === "manual") {
        return db.listCollectionVideoIds(collection.id);
    }

    const rule = parseCollectionRule(collection.ruleJson ? SafeJSON.parse(collection.ruleJson) : null);

    if (!rule) {
        logger.warn({ collectionId: collection.id }, "youtube collections: dynamic rule failed to parse");

        return [];
    }

    return db.listWatchedVideoIdsSince(collection.userId, ruleCutoffIso(rule));
}
