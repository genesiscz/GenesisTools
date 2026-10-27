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
    /** The widget panel's own background: "dark" (solid near-black), "glass", or "theme" (the app-wide theme). */
    panelBackground: z.enum(["dark", "glass", "theme"]).default("dark"),
    /** The hover list's rows show their waiting question under the session. */
    previewQuestion: z.boolean().default(true),
    display: z.string().default(""),
    providers: z.array(z.enum(["claude", "codex", "grok", "unknown"])).default([]),
    quietSeconds: z.number().int().min(3).max(300).default(15),
    voiceProvider: z.string().default("xai"),
    voiceAccount: z.string().nullable().optional(),
    voiceModel: z.string().nullable().optional(),
    voiceLanguage: z.string().default(""),
    /** Alert when a new decision reaches the inbox. */
    alertDecisions: z.boolean().default(true),
    /** Alert when a new answer or message reaches the inbox. */
    alertAnswers: z.boolean().default(true),
    /** The system sound an alert plays, by name; "none" plays no sound. */
    alertSound: z.string().trim().min(1).max(40).default("Glass"),
    /** Show the widget's own popup with an alert. */
    alertPopup: z.boolean().default(true),
    /** The agents hover list: only sessions that need you, or every active session too. */
    previewFilter: z.enum(["needs-you", "active"]).default("needs-you"),
    /** The agents hover list's order: waiting for you first, newest activity first, or by project. */
    previewSort: z.enum(["attention", "recent", "project"]).default("attention"),
    /** The sound an answer or message plays; "same" uses `alertSound`, "none" plays no sound. */
    alertAnswerSound: z.string().trim().min(1).max(40).default("same"),
    /** Seconds the session that raised an alert flashes in the widget; 0 does not flash it. */
    alertFlashSeconds: z.number().int().min(0).max(30).default(5),
    /** Where a session inbox puts its reply composer: under the tabs, or below the list. */
    inboxComposer: z.enum(["top", "bottom"]).default("top"),
    /** A rail session bubble's tooltip: only while hover previews are off ("auto"), always, or never. */
    bubbleTooltip: z.enum(["auto", "always", "never"]).default("auto"),
    /** The rail's session bubbles: in the hover list's order ("list"), or each keeps its place ("stable"). */
    railOrder: z.enum(["list", "stable"]).default("list"),
    /** A click on a decision option: stages the pick to send later with others ("stage"), or sends it at once. */
    decisionClick: z.enum(["stage", "send"]).default("stage"),
    /** ⌘-click on an option (and ⌘-Return in a decision's own answer) does the other: sends while a click stages. */
    decisionCommandSwaps: z.boolean().default(true),
    /** Return in a decision's own answer field: stages the text as its note ("stage"), or sends it as the answer. */
    ownAnswerReturn: z.enum(["stage", "send"]).default("stage"),
    /** When the widget starts with staged decisions, a popup lists them with Send now, until it is closed. */
    stagedReminder: z.boolean().default(true),
    /** Leaving the inbox with staged decisions: ask what to do ("ask"), keep them staged, or send them. */
    stagedOnLeave: z.enum(["ask", "keep", "send"]).default("ask"),
    /** Seconds before a successful send-and-close folds the panel; 0 keeps it open. */
    sendCloseSeconds: z.number().min(0).max(60).default(2.5),
    /** The inbox of every session: entries grouped under their session ("session"), or one list. */
    inboxGrouping: z.enum(["session", "list"]).default("session"),
    /** The filter a session's inbox opens with: every entry ("all"), the inbox entries, or the decisions. */
    inboxFilter: z.enum(["all", "inbox", "decisions"]).default("all"),
    /** The filter the inbox of every session opens with: every entry ("all"), the ones that need you, or unread. */
    overviewFilter: z.enum(["all", "needs", "unread"]).default("all"),
    /** The composer's microphone: records a voice note and puts its transcript in the field ("note"), or live dictation. */
    composerVoice: z.enum(["ask", "note", "live"]).default("ask"),
    /** Seconds the alert popup stays while the pointer is not on it; 0 keeps it until it is closed or answered. */
    alertPopupSeconds: z.number().int().min(0).max(60).default(7),
    /** A click outside the widget closes the alert popup. */
    alertPopupClickAway: z.boolean().default(false),
    /** Another alert while the popup is open: listed under the first ("list"), shown after it ("queue"), or replacing it. */
    alertPopupMany: z.enum(["list", "queue", "newest"]).default("list"),
    /** After a pick sent from the alert popup: stay in the popup with its result ("stay"), or open its session. */
    popupSendOpens: z.enum(["stay", "session"]).default("stay"),
    /** The alert sounds' volume, in percent of the system volume. */
    alertVolume: z.number().int().min(0).max(100).default(100),
    /** A decision answered outside the widget (an agent recorded the chat answer, or a reply was read) pops up. */
    autoDecisionPopup: z.boolean().default(true),
    /** Seconds that popup stays while the pointer is not on it; 0 keeps it until it is closed. */
    autoDecisionSeconds: z.number().int().min(0).max(60).default(5),
    /** The sound it plays: a system sound name, "same" for `alertSound`, or "none". */
    autoDecisionSound: z.string().trim().min(1).max(40).default("Tink"),
    /** Seconds a widget note stays before it fades; 0 keeps it until it is closed. A note with a button stays 10 s or more. */
    noteSeconds: z.number().int().min(0).max(60).default(6),
    /** A global shortcut opens and closes the widget from any app. */
    openShortcutEnabled: z.boolean().default(true),
    /** That shortcut: a Carbon virtual key code and modifier mask (GenesisKit `HotkeyChord`); ⌃⌥⌘W by default. */
    openShortcut: z
        .object({
            keyCode: z.number().int().min(0).max(255),
            modifiers: z.number().int().min(0).max(0xffff),
        })
        .default({ keyCode: 0x0d, modifiers: 0x1900 }),
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
            payloadHash: z.string().optional(),
            payloadRevision: z.string().optional(),
        })
        .optional(),
    dispatchedAt: z.number().optional(),
});
export type WidgetOutgoing = z.infer<typeof widgetOutgoingSchema>;
export const SHOWN_OUTGOING_HISTORY = 20;

/**
 * The outgoing messages the widget lists for one conversation: the last 20, plus every older message that is not yet
 * sent or cancelled. An unsettled message blocks its whole conversation (`nextOutgoingByConversation`), so its Retry,
 * Edit and review controls must stay reachable however many follow-ups queue behind it. Mirrors
 * `WidgetOutgoing.shown` in WidgetWireModels.swift.
 */
export function shownOutgoing(messages: WidgetOutgoing[]): WidgetOutgoing[] {
    const start = messages.length - SHOWN_OUTGOING_HISTORY;
    return messages.filter(
        (message, index) => index >= start || (message.state !== "sent" && message.state !== "cancelled")
    );
}
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
    inboxRead: z.record(z.string(), z.number().finite().nonnegative()).default({}),
    /** "Mark all read": items at or before this time stop counting in the badges; they stay in their sessions. */
    inboxClearedAt: z.number().finite().nonnegative().optional(),
    /** `tools hub widget show-decision`: the running widget shows this decision once per `at` (a decision link). */
    showDecision: z.object({ id: z.string().min(1), at: z.number().finite() }).optional(),
});
export type WidgetState = z.infer<typeof widgetStateSchema>;
