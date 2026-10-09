import { logger } from "@genesiscz/utils/logger";
import { videoSettingsSchema } from "@genesiscz/utils/video/types";
import { z } from "zod";

export const widgetTargetSchema = z.object({
    hostId: z.literal("local").default("local"),
    provider: z.enum(["claude", "codex", "grok", "unknown"]),
    sessionId: z.string().min(1),
    sourceHome: z.string().default(""),
    cwd: z.string().default(""),
});
export type WidgetTarget = z.infer<typeof widgetTargetSchema>;
export function widgetSessionKey(target: WidgetTarget): string {
    return [target.hostId, target.provider, target.sessionId, target.sourceHome].map(encodeURIComponent).join(":");
}

export function parseWidgetSessionKey(key: string): WidgetTarget | undefined {
    try {
        const parts = key.split(":").map(decodeURIComponent);
        if (parts.length !== 4) {
            return undefined;
        }
        const [hostId, provider, sessionId, sourceHome] = parts;
        const result = widgetTargetSchema.safeParse({ hostId, provider, sessionId, sourceHome });
        return result.success ? result.data : undefined;
    } catch (error) {
        logger.debug({ error }, "Invalid widget session identity");
        return undefined;
    }
}

export const widgetPreferencesSchema = z.object({
    excludedKeys: z.array(z.string()).default([]),
    projects: z.array(z.string()).default([]),
    sessions: z.array(z.string()).default([]),
    showChanges: z.boolean().default(true),
    /** "Show the widget" in the Widget settings: the top and side panels exist only while it is on. */
    showWidget: z.boolean().default(false),
    placement: z.enum(["top", "side", "both"]).default("both"),
    side: z.enum(["left", "right"]).default("right"),
    topModules: z
        .array(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/))
        .max(12)
        .default(["agents"]),
    sideGroups: z
        .array(z.array(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)).max(12))
        .length(3)
        .default([["agents"], ["capture", "shelf"], ["focus", "voice", "tasks"]]),
    sideLayout: z.enum(["joined", "separated"]).default("joined"),
    sideStyle: z.enum(["modular", "classic"]).default("modular"),
    joinedEdges: z.boolean().default(true),
    sidePosition: z.number().min(0).max(1).default(0.5),
    hoverPreviews: z.boolean().default(true),
    glassEffect: z.boolean().default(true),
    display: z.string().default(""),
    providers: z.array(z.enum(["claude", "codex", "grok", "unknown"])).default([]),
    quietSeconds: z.number().int().min(3).max(300).default(15),
    voiceProvider: z.string().default("xai"),
    voiceAccount: z.string().nullable().optional(),
    voiceModel: z.string().nullable().optional(),
    voiceLanguage: z.string().default(""),
});

// Zod defaults also run inside partial objects; a patch must retain only supplied keys.
export const widgetPreferencesPatchSchema = z.record(z.string(), z.unknown()).transform((input, context) => {
    const parsed = widgetPreferencesSchema.partial().safeParse(input);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            context.addIssue({ ...issue });
        }
        return z.NEVER;
    }
    return Object.fromEntries(Object.entries(parsed.data).filter(([key]) => Object.hasOwn(input, key))) as Partial<
        z.infer<typeof widgetPreferencesSchema>
    >;
});

const attachmentBase = {
    id: z.string().uuid(),
    name: z.string(),
    path: z.string(),
    sha256: z.string(),
};
export const widgetAssetSchema = z.discriminatedUnion("type", [
    z.object({
        ...attachmentBase,
        type: z.literal("image"),
        mimeType: z.string(),
        width: z.number(),
        height: z.number(),
        bytes: z.number(),
    }),
    z.object({
        ...attachmentBase,
        type: z.literal("video"),
        durationUs: z.number(),
        width: z.number(),
        height: z.number(),
        settings: videoSettingsSchema,
        revision: z.number().int().positive(),
        confirmedRevision: z.number().int().optional(),
        status: z.enum(["pending", "preparing", "ready", "failed"]),
        manifestPath: z.string().optional(),
        error: z.string().optional(),
        progress: z.object({ phase: z.string(), completed: z.number(), total: z.number() }).optional(),
    }),
]);
export type WidgetAsset = z.infer<typeof widgetAssetSchema>;

export const widgetPayloadSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("followup"), text: z.string().max(64_000) }),
    z.object({
        kind: z.literal("decision"),
        id: z.string(),
        number: z.number().int().positive(),
        expectedRevision: z.number().int().positive(),
        option: z.string().optional(),
        text: z.string().max(64_000).default(""),
    }),
    z.object({
        kind: z.literal("form"),
        id: z.string(),
        /** What the user wrote in the composer beside the answers: sent with them as context, kept on Edit. */
        text: z.string().max(64_000).default(""),
        answers: z.array(
            z.object({
                itemId: z.string(),
                freeText: z.string().optional(),
                selectedChoices: z.array(z.string()).optional(),
                fileTags: z.array(z.string()).optional(),
            })
        ),
    }),
]);
export type WidgetPayload = z.infer<typeof widgetPayloadSchema>;
export const outgoingStates = [
    "preparing",
    "review",
    "queued",
    "dispatching",
    "sent",
    "waiting-route",
    "unknown",
    "failed",
    "cancelled",
] as const;
export const widgetOutgoingSchema = z.object({
    id: z.string().uuid(),
    target: widgetTargetSchema,
    payload: widgetPayloadSchema,
    assetIds: z.array(z.string()).max(24),
    createdAt: z.number(),
    sequence: z.number().int(),
    state: z.enum(outgoingStates),
    error: z.string().optional(),
    receipt: z
        .object({
            channel: z.string(),
            delivered: z.boolean(),
            at: z.number(),
            detail: z.string().optional(),
            entryId: z.string().optional(),
        })
        .optional(),
    dispatchedAt: z.number().optional(),
});
export type WidgetOutgoing = z.infer<typeof widgetOutgoingSchema>;
export const widgetDraftSchema = z.object({
    text: z.string().max(64_000).default(""),
    assetIds: z.array(z.string()).max(24).default([]),
});
export const widgetStateSchema = z.object({
    selectedKey: z.string().nullable().default(null),
    version: z.literal(1).default(1),
    revision: z.number().int().default(0),
    preferences: widgetPreferencesSchema.prefault({}),
    assets: z.record(z.string(), widgetAssetSchema).default({}),
    drafts: z.record(z.string(), widgetDraftSchema).default({}),
    outgoing: z.array(widgetOutgoingSchema).default([]),
});
export type WidgetState = z.infer<typeof widgetStateSchema>;
