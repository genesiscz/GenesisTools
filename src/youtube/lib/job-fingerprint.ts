import { createHash } from "node:crypto";
import type { JobStage, JobTargetKind } from "@app/youtube/lib/jobs.types";
import { SafeJSON } from "@genesiscz/utils/json";

export interface BuildJobFingerprintInput {
    targetKind: JobTargetKind;
    target: string;
    stages: JobStage[];
    params?: Record<string, unknown> | null;
    userId?: number | null;
}

/**
 * Deterministic identity for "this job would do the same work" — used to
 * coalesce duplicate enqueue calls (see `YoutubeDatabase.enqueueJob`).
 * Hashes a canonical structured form (sorted params, question pre-hashed) so
 * free-text params can't collide via delimiter injection, and scopes user-owned
 * work by `userId` so jobs never coalesce across users.
 */
export function buildJobFingerprint({ targetKind, target, stages, params, userId }: BuildJobFingerprintInput): string {
    const canonical = SafeJSON.stringify(
        {
            targetKind,
            target,
            stages,
            params: canonicalParams(params),
            userId: userId ?? null,
        },
        { strict: true }
    );

    return createHash("sha1")
        .update(canonical ?? "")
        .digest("hex");
}

function canonicalParams(params: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!params) {
        return null;
    }

    // Ephemeral per-request fields must not participate in coalesce identity.
    const omit = new Set(["holdId", "creditCost"]);
    const canonical: Record<string, unknown> = {};

    for (const key of Object.keys(params).sort()) {
        if (omit.has(key)) {
            continue;
        }

        const value = params[key];

        if (value === undefined) {
            continue;
        }

        canonical[key] = key === "question" && typeof value === "string" ? shortHash(value) : value;
    }

    return canonical;
}

function shortHash(value: string): string {
    return createHash("sha1").update(value).digest("hex").slice(0, 16);
}
