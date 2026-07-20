import { createHash } from "node:crypto";
import type { JobStage, JobTargetKind } from "@app/youtube/lib/jobs.types";
import { SafeJSON } from "@genesiscz/utils/json";

export interface BuildJobFingerprintInput {
    targetKind: JobTargetKind;
    target: string;
    stages: JobStage[];
    params?: Record<string, unknown> | null;
}

/**
 * Deterministic identity for "this job would do the same work" — used to
 * coalesce duplicate enqueue calls (see `YoutubeDatabase.enqueueJob`).
 * Format: `targetKind|target|stagesJoined|sortedParamPairs`.
 */
export function buildJobFingerprint({ targetKind, target, stages, params }: BuildJobFingerprintInput): string {
    return `${targetKind}|${target}|${stages.join(",")}|${serializeParams(params)}`;
}

function serializeParams(params: Record<string, unknown> | null | undefined): string {
    if (!params) {
        return "";
    }

    // Ephemeral per-request fields must not participate in coalesce identity.
    const omit = new Set(["holdId", "creditCost"]);
    const pairs: string[] = [];

    for (const key of Object.keys(params).sort()) {
        if (omit.has(key)) {
            continue;
        }

        const value = params[key];

        if (value === undefined) {
            continue;
        }

        pairs.push(`${key}=${serializeParamValue(key, value)}`);
    }

    return pairs.join(",");
}

function serializeParamValue(key: string, value: unknown): string {
    if (key === "question" && typeof value === "string") {
        return shortHash(value);
    }

    if (typeof value === "string") {
        return value;
    }

    return SafeJSON.stringify(value);
}

function shortHash(value: string): string {
    return createHash("sha1").update(value).digest("hex").slice(0, 16);
}
