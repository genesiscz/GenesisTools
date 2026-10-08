import { SafeJSON } from "@genesiscz/utils/json";
import { type RecastAnchor, type RecastDocument, type RecastRegion, readRecastDocument } from "./document";

function normalized(text: string): string {
    return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

function words(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu)
            ?.slice(0, 64) ?? []
    );
}

function overlap(a: RecastRegion, b: RecastRegion): number {
    if (a.kind !== "rect" || b.kind !== "rect" || a.page !== b.page) {
        return 0;
    }
    const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const intersection = width * height;
    return intersection / (a.width * a.height + b.width * b.height - intersection);
}

function visualSimilarity(a: string | undefined, b: string | undefined): number {
    if (!a || !b || a.length !== 64 || b.length !== 64) {
        return 0;
    }
    let different = 0;
    let ink = 0;
    for (let index = 0; index < 64; index++) {
        const old = Number.parseInt(a[index], 16);
        let xor = old ^ Number.parseInt(b[index], 16);
        let bits = old;
        while (xor) {
            different += xor & 1;
            xor >>>= 1;
        }
        while (bits) {
            ink += bits & 1;
            bits >>>= 1;
        }
    }
    return ink > 8 && ink < 248 ? 1 - different / 256 : 0;
}

export function activeSourceAnchors(document: RecastDocument, sourceId: string): RecastAnchor[] {
    const used = new Set(
        document.records
            .filter((record) => record.state !== "archived")
            .flatMap((record) => Object.values(record.cells).flatMap((cell) => cell.anchorIds))
    );
    return document.anchors.filter((anchor) => anchor.sourceId === sourceId && used.has(anchor.id));
}

function matchingContext(a: RecastRegion, b: RecastRegion): boolean {
    if (a.kind !== "text" || b.kind !== "text") {
        return false;
    }
    const before = normalized(a.prefix ?? "");
    const after = normalized(a.suffix ?? "");
    return (
        Boolean(before || after) &&
        (!before || normalized(b.prefix ?? "") === before) &&
        (!after || normalized(b.suffix ?? "") === after)
    );
}

export interface ReconciliationCandidate {
    anchorId: string;
    method: "same-bytes" | "exact-reading" | "context-reading" | "similar-reading" | "similar-image";
    quote: string;
    score: number;
}

export function previewReconciliation({
    input,
    oldSourceId,
    newSourceId,
    jobId,
}: {
    input: unknown;
    oldSourceId: string;
    newSourceId: string;
    jobId?: string;
}) {
    const document = readRecastDocument(input);
    const oldSource = document.sources.find((source) => source.id === oldSourceId);
    const newSource = document.sources.find((source) => source.id === newSourceId);
    if (!oldSource || !newSource || oldSource.id === newSource.id) {
        throw new Error("Choose two distinct source snapshots.");
    }
    const job = jobId ? document.reconciliations.find((entry) => entry.id === jobId) : undefined;
    if (jobId && (!job || job.oldSourceId !== oldSourceId || job.newSourceId !== newSourceId)) {
        throw new Error("Choose the reconciliation for these source snapshots.");
    }
    const allAnchors = new Map(document.anchors.map((anchor) => [anchor.id, anchor]));
    const decisions = new Map(job?.items.map((item) => [item.oldAnchorId, item]) ?? []);
    const oldAnchors = job
        ? job.items.flatMap((item) => {
              const anchor = allAnchors.get(item.oldAnchorId);
              return anchor ? [anchor] : [];
          })
        : activeSourceAnchors(document, oldSourceId);
    const newAnchors = document.anchors.filter((anchor) => anchor.sourceId === newSourceId);
    const readings = new Map<string, string[]>();
    for (const reading of document.readings) {
        const texts = readings.get(reading.anchorId) ?? [];
        texts.push(reading.text);
        readings.set(reading.anchorId, texts);
    }
    const textFor = (anchor: RecastAnchor) => normalized((readings.get(anchor.id) ?? []).join("\n"));
    const textMap = new Map(newAnchors.map((anchor) => [anchor.id, textFor(anchor)]));
    const tokens = new Map(newAnchors.map((anchor) => [anchor.id, words(textMap.get(anchor.id) ?? "")]));
    const exact = new Map<string, RecastAnchor[]>();
    const byWord = new Map<string, RecastAnchor[]>();
    const byPage = new Map<number, RecastAnchor[]>();
    const byRegion = new Map<string, RecastAnchor[]>();
    for (const anchor of newAnchors) {
        const text = textMap.get(anchor.id) ?? "";
        if (text) {
            const matches = exact.get(text) ?? [];
            matches.push(anchor);
            exact.set(text, matches);
        }
        for (const word of tokens.get(anchor.id) ?? []) {
            const matches = byWord.get(word) ?? [];
            matches.push(anchor);
            byWord.set(word, matches);
        }
        if (anchor.region.kind === "rect") {
            const matches = byPage.get(anchor.region.page) ?? [];
            matches.push(anchor);
            byPage.set(anchor.region.page, matches);
        }
        const key = SafeJSON.stringify(anchor.region);
        const regions = byRegion.get(key) ?? [];
        regions.push(anchor);
        byRegion.set(key, regions);
    }
    const sameBytes = oldSource.contentHash === newSource.contentHash && oldSource.kind === newSource.kind;
    const items = oldAnchors.map((anchor) => {
        const text = textFor(anchor);
        const decision = decisions.get(anchor.id);
        let candidates: ReconciliationCandidate[] = [];
        let candidateCount = 0;
        if (sameBytes) {
            const matches = byRegion.get(SafeJSON.stringify(anchor.region)) ?? [];
            candidateCount = matches.length;
            candidates = matches.slice(0, 8).map((next) => ({
                anchorId: next.id,
                method: "same-bytes",
                quote: textMap.get(next.id) ?? "",
                score: 1,
            }));
        }
        if (!candidates.length && text) {
            const exactMatches = exact.get(text) ?? [];
            const contextual = exactMatches.filter((next) => matchingContext(anchor.region, next.region));
            const matches = contextual.length ? contextual : exactMatches;
            candidateCount = matches.length;
            candidates = matches.slice(0, 8).map((next) => ({
                anchorId: next.id,
                method: contextual.length ? "context-reading" : "exact-reading",
                quote: textMap.get(next.id) ?? "",
                score: 1,
            }));
        }
        if (!candidates.length) {
            const oldWords = words(text);
            const rare = [...oldWords]
                .map((word) => byWord.get(word) ?? [])
                .filter((entries) => entries.length)
                .sort((a, b) => a.length - b.length)
                .slice(0, 2);
            const nearby =
                anchor.region.kind === "rect"
                    ? (byPage.get(anchor.region.page) ?? [])
                          .filter((next) => overlap(anchor.region, next.region) >= 0.25)
                          .slice(0, 64)
                    : [];
            const pool = new Map(
                [...rare.flatMap((entries) => entries.slice(0, 64)), ...nearby].map((next) => [next.id, next])
            );
            for (const next of pool.values()) {
                const nextWords = tokens.get(next.id) ?? new Set<string>();
                const common = [...oldWords].filter((word) => nextWords.has(word)).length;
                const textScore =
                    oldWords.size >= 3 && nextWords.size >= 3 ? (2 * common) / (oldWords.size + nextWords.size) : 0;
                const imageScore =
                    overlap(anchor.region, next.region) >= 0.25
                        ? visualSimilarity(anchor.fingerprint, next.fingerprint)
                        : 0;
                if (textScore >= 0.78 || imageScore >= 0.92) {
                    candidates.push({
                        anchorId: next.id,
                        method: textScore >= 0.78 ? "similar-reading" : "similar-image",
                        quote: textMap.get(next.id) ?? "",
                        score: Math.max(textScore, imageScore),
                    });
                }
            }
        }
        candidateCount = Math.max(candidateCount, candidates.length);
        candidates.sort((a, b) => b.score - a.score || a.anchorId.localeCompare(b.anchorId));
        const match =
            candidateCount === 0
                ? "unmatched"
                : candidateCount > 1
                  ? "ambiguous"
                  : candidates[0].method === "same-bytes"
                    ? "unchanged"
                    : ["exact-reading", "context-reading"].includes(candidates[0].method)
                      ? "exact"
                      : "similar";
        return {
            oldAnchorId: anchor.id,
            label: anchor.label,
            quote: text,
            match,
            candidateCount,
            candidates: candidates.slice(0, 8),
            decision: decision?.status ?? "preview",
            newAnchorId: decision?.newAnchorId,
        };
    });
    return { documentId: document.id, revision: document.revision, oldSourceId, newSourceId, jobId, items };
}
