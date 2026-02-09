// Shared utility functions for GitHub commands

import chalk from "chalk";
import type { CommentData, CommentRecord, GitHubReactions } from "@app/github/types";

/**
 * Global verbose state for HTTP request logging
 */
let globalVerbose = false;

export function setGlobalVerbose(value: boolean): void {
    globalVerbose = value;
}

export function isGlobalVerbose(): boolean {
    return globalVerbose;
}

/**
 * Log message if global verbose is enabled (for use in utilities that don't have options context)
 */
export function verboseLog(message: string): void {
    if (globalVerbose) {
        console.log(chalk.cyan(message));
    }
}

/**
 * Interface for options that support verbose logging
 */
export interface VerboseOptions {
    verbose?: boolean;
}

/**
 * Verbose logging helper
 * Outputs cyan messages when verbose mode is enabled
 */
export function verbose<T extends VerboseOptions>(options: T, message: string): void {
    if (options.verbose) {
        console.log(chalk.cyan(message));
    }
}

/**
 * Sum ALL reactions generically (iterates all numeric keys, skips total_count).
 * Future-proof: if GitHub adds new reaction types, they're included automatically.
 */
export function sumReactions(reactions: GitHubReactions): number {
    let sum = 0;
    for (const [key, value] of Object.entries(reactions)) {
        if (key !== "total_count" && typeof value === "number") {
            sum += value;
        }
    }
    return sum;
}

const POSITIVE_REACTIONS: (keyof GitHubReactions)[] = ["+1", "laugh", "hooray", "heart", "rocket", "eyes"];
const NEGATIVE_REACTIONS: (keyof GitHubReactions)[] = ["-1", "confused"];

export function sumPositiveReactions(reactions: GitHubReactions): number {
    return POSITIVE_REACTIONS.reduce((sum, key) => sum + ((reactions[key] as number) || 0), 0);
}

export function sumNegativeReactions(reactions: GitHubReactions): number {
    return NEGATIVE_REACTIONS.reduce((sum, key) => sum + ((reactions[key] as number) || 0), 0);
}

/**
 * Convert comment data to cache record
 */
export function toCommentRecord(comment: CommentData, issueId: number): CommentRecord {
    return {
        id: String(comment.id),
        issue_id: issueId,
        author: comment.author,
        body: comment.body,
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        reaction_count: sumReactions(comment.reactions),
        reactions_json: JSON.stringify(comment.reactions),
        is_bot: comment.isBot ? 1 : 0,
    };
}

const DEFAULT_REACTIONS = {
    total_count: 0,
    "+1": 0,
    "-1": 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
};

/**
 * Convert cache record to comment data
 */
export function fromCommentRecord(record: CommentRecord): CommentData {
    let reactions = { ...DEFAULT_REACTIONS };
    try {
        const parsed = JSON.parse(record.reactions_json || "{}");
        reactions = { ...DEFAULT_REACTIONS, ...parsed };
    } catch {
        // Invalid JSON, use empty reactions
    }

    return {
        id: parseInt(record.id, 10),
        nodeId: `IC_${record.id}`, // Synthetic node ID since we only store REST id
        author: record.author,
        body: record.body,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
        reactions,
        isBot: record.is_bot === 1,
        htmlUrl: "",
    };
}
