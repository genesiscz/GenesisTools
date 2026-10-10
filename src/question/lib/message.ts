import { isAbsolute, resolve } from "node:path";
import type { SourceMessage } from "@genesiscz/utils/agent/source-anchor";
import type { ImageAttachmentInput } from "@genesiscz/utils/image/attachments";
import { type RecordDeps, recordAnswer } from "./record";
import type { QaRef, QaSource, RecordResult } from "./types";

/** The longest title derived from the first line of a message; the card title wraps, a paragraph does not. */
const MAX_DERIVED_TITLE = 120;

/**
 * Plain image paths (`images`) plus full attachment objects, as one attachment list. A relative path resolves
 * against `cwd` (the agent's worktree for the CLI); the importer then requires it to exist and be PNG/JPEG/WebP.
 * Undefined when neither was given, so the entry keeps `attachments: []` without an import.
 */
export function imageInputs({
    images,
    attachments,
    cwd = process.cwd(),
}: {
    images?: string[];
    attachments?: ImageAttachmentInput[];
    cwd?: string;
}): ImageAttachmentInput[] | undefined {
    const fromPaths = (images ?? [])
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
        .map((path): ImageAttachmentInput => ({ type: "image", path: isAbsolute(path) ? path : resolve(cwd, path) }));
    const all = [...fromPaths, ...(attachments ?? [])];

    return all.length > 0 ? all : undefined;
}

/** The card title of a message: the given title, else its first line without a markdown heading marker. */
export function messageTitle(text: string, title?: string): string {
    const given = title?.trim();

    if (given) {
        return given;
    }

    const first = (text.trim().split("\n")[0] ?? "").replace(/^#{1,6}\s+/, "").trim();

    if (first.length <= MAX_DERIVED_TITLE) {
        return first;
    }

    return `${first.slice(0, MAX_DERIVED_TITLE - 1).trimEnd()}…`;
}

export interface InboxMessageInput {
    text: string;
    title?: string;
    images?: string[];
    attachments?: ImageAttachmentInput[];
    refs?: QaRef[];
    sessionHint?: string;
    projectPath?: string;
    sourceMessage?: SourceMessage;
    agentLabel?: string;
    source: QaSource;
}

/**
 * The one core behind `inbox_send` and `tools question message`: an agent-to-user message, optionally with
 * screenshots, stored as a Q→A entry tagged `message`. The widget shows it as an unread, expandable card under the
 * posting session (src/hub/lib/widget/snapshot.ts). The session comes from `gatherHarnessPoster` inside
 * `recordAnswer`, the same stamp handoffs and decisions use: CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or
 * GROK_SESSION_ID in a harness child, or the gateway's resolved caller over HTTP.
 */
export async function sendInboxMessage(input: InboxMessageInput, deps: RecordDeps = {}): Promise<RecordResult> {
    const text = input.text?.trim() ?? "";
    const attachments = imageInputs({ images: input.images, attachments: input.attachments, cwd: input.projectPath });

    if (!text && !attachments) {
        throw new Error("a message needs text, an image, or both");
    }

    const answer = text || "Screenshot attached.";

    return recordAnswer(
        {
            question: messageTitle(answer, input.title),
            answer,
            tag: "message",
            refs: input.refs,
            attachments,
            sessionId: input.sessionHint,
            projectPath: input.projectPath,
            sourceMessage: input.sourceMessage,
            agentLabel: input.agentLabel,
            source: input.source,
        },
        deps
    );
}
