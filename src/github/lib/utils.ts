// Shared utility functions for GitHub commands

import chalk from 'chalk';
import type { CommentData, CommentRecord } from '@app/github/types';

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
    reaction_count: comment.reactions.total_count,
    reactions_json: JSON.stringify(comment.reactions),
    is_bot: comment.isBot ? 1 : 0,
  };
}

/**
 * Convert cache record to comment data
 */
export function fromCommentRecord(record: CommentRecord): CommentData {
  return {
    id: parseInt(record.id, 10),
    nodeId: record.id,
    author: record.author,
    body: record.body,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    reactions: JSON.parse(record.reactions_json || '{}'),
    isBot: record.is_bot === 1,
    htmlUrl: '',
  };
}
