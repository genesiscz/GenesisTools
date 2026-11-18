import {
    findHandoffAttachment,
    type HandoffEventPage,
    handoffQueries,
} from "@genesiscz/utils/work/legacy/handoff-read";
import { attachmentFilePath } from "./attachments";
import { applyGetClaim, type HandoffDeps } from "./executor";
import { HandoffReader, withHandoffReadDb } from "./reader";

export const workHandoffReader = new HandoffReader(handoffQueries, applyGetClaim);

export function readHandoffEventPage(page: Omit<HandoffEventPage, "db">, deps: HandoffDeps = {}) {
    return withHandoffReadDb(deps, (db) => {
        if (handoffQueries.getHandoffById(db, page.handoffId) === null) {
            return null;
        }

        return handoffQueries.listHandoffEvents({ db, ...page });
    });
}

export function readHandoffAttachment(attachmentId: string, deps: HandoffDeps = {}) {
    return withHandoffReadDb(deps, (db) => {
        const found = findHandoffAttachment(db, attachmentId);
        if (found === null) {
            return null;
        }

        return { ...found, path: attachmentFilePath(found.handoffId, attachmentId, found.filename, deps.base) };
    });
}
