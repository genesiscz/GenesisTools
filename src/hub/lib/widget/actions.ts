import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { readDecisions, updateDecision } from "@app/question/lib/decisions/store";
import { getEntryById, markEntriesRead, openReadModel } from "@app/question/lib/read-model";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { videoSettingsSchema } from "@genesiscz/utils/video/types";
import { z } from "zod";
import { confirmVideoAsset, importWidgetAsset, reviseVideoAsset } from "../composer/assets";
import { changeOutgoing, enqueueWidgetMessage } from "../composer/outbox";
import { createWidgetHandoff } from "./handoff";
import { readShelfAttachment } from "./shelf";
import { acknowledgeWidgetInbox, mutateWidgetState, readWidgetState, widgetRoot } from "./storage";
import {
    parseWidgetSessionKey,
    widgetDraftSchema,
    widgetPayloadSchema,
    widgetPreferencesPatchSchema,
    widgetPreferencesSchema,
    widgetTargetSchema,
} from "./types";

export const widgetActionSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("selection"), key: z.string().nullable() }),
    z.object({ action: z.literal("handoff"), key: z.string() }),
    z.object({ action: z.literal("shelf-attachment"), key: z.string(), id: z.string() }),
    z.object({
        action: z.literal("ledger"),
        id: z.string(),
        sessionId: z.string(),
        expectedRevision: z.number().int().positive(),
        state: z.enum(["drafted", "dismissed", "acknowledged", "implemented"]),
        draft: z.string().optional(),
        draftOption: z.string().optional(),
    }),
    z.object({ action: z.literal("preferences"), patch: widgetPreferencesPatchSchema }),
    z.object({ action: z.literal("visibility"), key: z.string(), pinned: z.boolean() }),
    z.object({ action: z.literal("draft"), key: z.string(), draft: widgetDraftSchema }),
    z.object({ action: z.literal("draft-text"), key: z.string(), text: z.string().max(64_000) }),
    z.object({ action: z.literal("append-draft"), key: z.string(), text: z.string().max(64_000) }),
    z.object({ action: z.literal("import"), key: z.string(), input: z.string(), type: z.enum(["image", "video"]) }),
    z.object({ action: z.literal("capture"), key: z.string() }),
    z.object({ action: z.literal("remove-asset"), key: z.string(), id: z.string() }),
    z.object({ action: z.literal("video-settings"), id: z.string(), settings: videoSettingsSchema }),
    z.object({ action: z.literal("confirm-video"), id: z.string(), revision: z.number().int() }),
    z.object({
        action: z.literal("enqueue"),
        id: z.string().uuid(),
        target: widgetTargetSchema,
        payload: widgetPayloadSchema,
        assetIds: z.array(z.string()).default([]),
        draftSnapshot: widgetDraftSchema.optional(),
    }),
    z.object({ action: z.literal("retry"), id: z.string(), confirmedUnknown: z.boolean().default(false) }),
    z.object({ action: z.literal("cancel"), id: z.string(), confirmedUnknown: z.boolean().default(false) }),
    z.object({ action: z.literal("edit"), id: z.string() }),
    z.object({ action: z.literal("read"), id: z.string() }),
    z.object({
        action: z.literal("inbox-read"),
        key: z.string(),
        id: z.string(),
        kind: z.enum(["answer", "result", "form", "decision"]),
        at: z.number().finite().nonnegative(),
    }),
]);

export async function performWidgetAction({
    root,
    input,
    signal,
}: {
    root?: string;
    input: unknown;
    signal?: AbortSignal;
}): Promise<unknown> {
    const request = widgetActionSchema.parse(input);
    switch (request.action) {
        case "shelf-attachment":
            return readShelfAttachment({ root, key: request.key, id: request.id });
        case "handoff":
            return createWidgetHandoff({ root, key: request.key });
        case "ledger": {
            const files = decisionFiles();
            const row = readDecisions(files.file).find((entry) => entry.id === request.id);
            if (!row || row.sessionId !== request.sessionId) {
                throw new Error("This item belongs to another session.");
            }
            return updateDecision(files.file, files.events, request.id, {
                state: request.state,
                expectedRevision: request.expectedRevision,
                ...(request.draft !== undefined ? { draft: request.draft } : {}),
                ...(request.draftOption !== undefined ? { draftOption: request.draftOption } : {}),
            });
        }
        case "selection":
            return mutateWidgetState(root, (state) => {
                state.selectedKey = request.key;
            });
        case "preferences":
            return mutateWidgetState(root, (state) => {
                state.preferences = widgetPreferencesSchema.parse({ ...state.preferences, ...request.patch });
                return state.preferences;
            });
        case "visibility":
            return mutateWidgetState(root, (state) => {
                const excluded = new Set(state.preferences.excludedKeys);
                if (request.pinned) {
                    excluded.delete(request.key);
                } else {
                    excluded.add(request.key);
                }
                state.preferences.excludedKeys = [...excluded];
                return state.preferences;
            });
        case "draft":
            return mutateWidgetState(root, (state) => {
                state.drafts[request.key] = request.draft;
                return request.draft;
            });
        case "draft-text":
            return mutateWidgetState(root, (state) => {
                const draft = state.drafts[request.key] ?? { text: "", assetIds: [] };
                draft.text = request.text;
                state.drafts[request.key] = draft;
                return draft;
            });
        case "append-draft":
            return mutateWidgetState(root, (state) => {
                const draft = state.drafts[request.key] ?? { text: "", assetIds: [] };
                draft.text = [draft.text, request.text].filter(Boolean).join(" ");
                state.drafts[request.key] = draft;
                return draft;
            });
        case "import": {
            const asset = await importWidgetAsset({ root, input: request.input, type: request.type });
            await mutateWidgetState(root, (state) => {
                const draft = state.drafts[request.key] ?? { text: "", assetIds: [] };
                draft.assetIds.push(asset.id);
                state.drafts[request.key] = draft;
            });
            return asset;
        }
        case "capture": {
            await mkdir(widgetRoot(root), { recursive: true });
            const input = join(widgetRoot(root), `capture-${randomUUID()}.png`);
            try {
                const result = await boundedCommand({
                    command: ["/usr/sbin/screencapture", "-i", "-x", input],
                    signal,
                    timeoutMs: 120_000,
                });
                if (result.error || result.status !== 0 || !(await Bun.file(input).exists())) {
                    throw new Error("Screenshot selection cancelled or capture permission unavailable");
                }
                return await performWidgetAction({
                    root,
                    input: { action: "import", key: request.key, type: "image", input },
                    signal,
                });
            } finally {
                try {
                    await unlink(input);
                } catch (error) {
                    logger.debug({ error, path: input }, "Screenshot staging cleanup ended");
                }
            }
        }
        case "remove-asset":
            return mutateWidgetState(root, (state) => {
                const draft = state.drafts[request.key];
                if (draft) {
                    draft.assetIds = draft.assetIds.filter((id) => id !== request.id);
                }
            });
        case "video-settings":
            return reviseVideoAsset({ root, id: request.id, settings: request.settings });
        case "confirm-video":
            await confirmVideoAsset({ root, id: request.id, revision: request.revision });
            return { confirmed: true };
        case "enqueue":
            return enqueueWidgetMessage({ root, ...request });
        case "retry":
        case "cancel":
        case "edit":
            if (request.action === "cancel" || request.action === "edit") {
                const message = (await readWidgetState(root)).outgoing.find((entry) => entry.id === request.id);
                if (message?.payload.kind === "decision" && message.dispatchedAt) {
                    const id = message.payload.id;
                    const decision = readDecisions(decisionFiles().file).find((row) => row.id === id);
                    if (decision && !["open", "drafted"].includes(decision.state)) {
                        throw new Error(
                            "This answer is now owned by Decisions. Manage its delivery in Hub; cancelling here would not withdraw it."
                        );
                    }
                }
            }
            await changeOutgoing({ root, ...request });
            return { updated: true };
        case "inbox-read": {
            signal?.throwIfAborted();
            const target = parseWidgetSessionKey(request.key);
            if (!target || !request.id.startsWith(`${request.kind}:`)) {
                throw new Error("The notification identity is invalid.");
            }

            const sourceId = request.id.slice(request.kind.length + 1);
            if (request.kind === "answer") {
                const db = openReadModel(toolDataDir("question", "qa.db"));
                try {
                    const row = getEntryById(db, sourceId);
                    const provider = row?.agent === "claude-code" ? "claude" : row?.agent;
                    if (!row || (row.sessionId || row.id) !== target.sessionId || provider !== target.provider) {
                        throw new Error("The answer belongs to a different session.");
                    }

                    return { read: markEntriesRead(db, [sourceId]) };
                } finally {
                    db.close();
                }
            }

            if (request.kind === "result") {
                const separator = sourceId.indexOf(":");
                const provider = sourceId.slice(0, separator);
                if (
                    separator < 0 ||
                    provider !== target.provider ||
                    sourceId.slice(separator + 1) !== target.sessionId
                ) {
                    throw new Error("The result belongs to a different session.");
                }
            }

            return acknowledgeWidgetInbox({ root, key: request.key, id: request.id, at: request.at, signal });
        }
        case "read": {
            const db = openReadModel(toolDataDir("question", "qa.db"));
            try {
                return { read: markEntriesRead(db, [request.id]) };
            } finally {
                db.close();
            }
        }
    }
}
