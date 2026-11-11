import { savedDecisionActorSchema } from "@genesiscz/utils/meetings/record";
import { z } from "zod";
import { momentTargetSchema } from "./moment-schema";

/**
 * The shapes of a comment for the listening agent (comments.ts), kept apart so the Meetings service's descriptor
 * (service/api.ts, which every `tools meetings` read imports) and the decision journal name them without loading the
 * comments file's reader.
 */

/** One comment as it was staged: what it is on, what it says, and who wrote it. */
export const commentSchema = z.object({
    /** `c1`, `c2`, …: the meeting's comments in the order they were staged. */
    id: z.string().min(1),
    at: z.string().min(1),
    /** What the comment is on: words selected in the transcript (`selection`), or any Moment target. */
    target: momentTargetSchema,
    text: z.string().min(1),
    /** The selected words as the window shows them. */
    quote: z.string().optional(),
    actor: savedDecisionActorSchema,
});
export type StagedComment = z.infer<typeof commentSchema>;

/** A `listen --subscribe-answers --with-comments` process: it prints each sent comment while it runs. */
export const commentListenerSchema = z.object({
    pid: z.number().int().positive(),
    at: z.string().min(1),
    actor: savedDecisionActorSchema,
});
export type CommentListener = z.infer<typeof commentListenerSchema>;

/** A comment as `comment.list` answers it: staged (it can still be unstaged) or sent with the journal entry's token. */
export const meetingCommentSchema = commentSchema.extend({
    state: z.enum(["staged", "sent"]),
    sentAt: z.string().optional(),
    readAt: z.string().optional(),
    readBy: savedDecisionActorSchema.optional(),
    withdrawnAt: z.string().optional(),
    /** The journal entry of its send (kind `comment`). */
    token: z.string().optional(),
});
export type MeetingComment = z.infer<typeof meetingCommentSchema>;

/** A comment as the journal entry of its send keeps it (`comment` kind): what the agent was told. */
export const sentCommentSchema = commentSchema.pick({ id: true, target: true, text: true, quote: true });
