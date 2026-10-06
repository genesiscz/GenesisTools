import { newRecastID, type RecastDocument, sameRecastEvidence, unknownCell } from "./document";
import type { RecastOperation } from "./operations";

export function startContradiction({
    document,
    operation,
    at,
}: {
    document: RecastDocument;
    operation: Extract<RecastOperation, { kind: "start-contradiction" }>;
    at: string;
}): string[] {
    const collection = document.collections.find((entry) => entry.id === operation.collectionId);
    if (
        !collection?.fields.some((field) => field.id === operation.fieldId) ||
        new Set(operation.recordIds).size !== operation.recordIds.length
    ) {
        throw new Error("Choose distinct competing records and an existing field.");
    }
    const members = operation.recordIds.map((recordId) => {
        const record = document.records.find((entry) => entry.id === recordId);
        if (!record || record.collectionId !== collection.id || record.state === "archived") {
            throw new Error("Choose active records in the same collection.");
        }
        record.state = "draft";
        return { recordId, cell: structuredClone(record.cells[operation.fieldId] ?? unknownCell()), context: "" };
    });
    document.contradictions.push({
        id: operation.id ?? newRecastID("contradiction"),
        collectionId: collection.id,
        fieldId: operation.fieldId,
        label: operation.label,
        reason: operation.reason,
        createdAt: at,
        status: "pending",
        members,
    });
    return operation.recordIds;
}

export function applyContradictionDecision({
    document,
    operation,
    at,
}: {
    document: RecastDocument;
    operation: Extract<RecastOperation, { kind: "resolve-contradiction" }>;
    at: string;
}): string[] {
    const review = document.contradictions.find((entry) => entry.id === operation.reviewId);
    if (!review) {
        throw new Error("Choose an existing competing-evidence review.");
    }
    if (
        (operation.decision === "prefer" &&
            !review.members.some((member) => member.recordId === operation.preferredRecordId)) ||
        (operation.decision !== "prefer" && operation.preferredRecordId !== undefined) ||
        (operation.decision === "context" && review.members.some((member) => !operation.contexts?.[member.recordId])) ||
        (operation.contexts &&
            Object.keys(operation.contexts).some((id) => !review.members.some((member) => member.recordId === id)))
    ) {
        throw new Error("Choose the preferred record, or supply context for every competing record.");
    }
    for (const member of review.members) {
        const record = document.records.find((entry) => entry.id === member.recordId)!;
        member.cell = structuredClone(record.cells[review.fieldId] ?? unknownCell());
        member.context = operation.decision === "context" ? operation.contexts![member.recordId] : "";
        record.state =
            operation.decision === "prefer" && record.id !== operation.preferredRecordId ? "archived" : "draft";
    }
    review.status = "resolved";
    review.decision = operation.decision;
    review.preferredRecordId = operation.preferredRecordId;
    review.resolvedAt = at;
    review.reason = operation.reason;
    return review.members.map((member) => member.recordId);
}

export function refreshContradictions(document: RecastDocument): void {
    for (const review of document.contradictions) {
        if (review.status !== "resolved") {
            continue;
        }
        if (
            review.members.some((member) => {
                const record = document.records.find((entry) => entry.id === member.recordId)!;
                const expectedArchived = review.decision === "prefer" && member.recordId !== review.preferredRecordId;
                return (
                    !sameRecastEvidence(record.cells[review.fieldId] ?? unknownCell(), member.cell) ||
                    (expectedArchived ? record.state !== "archived" : record.state === "archived")
                );
            })
        ) {
            review.status = "pending";
            delete review.decision;
            delete review.preferredRecordId;
            delete review.resolvedAt;
            for (const member of review.members) {
                const record = document.records.find((entry) => entry.id === member.recordId)!;
                if (record.state !== "archived") {
                    record.state = "draft";
                }
            }
        }
    }
}
