/**
 * Send to my vault (F25). Types only (`contract-purity.test.ts`). A shared link becomes clean Markdown (or a queued
 * video transcription) in the vault's inbox note; any text (a saved Q→A answer, a memo note) is appended to a note.
 */

export interface VaultClipInput {
    url: string;
    /** A line the user adds above the clip. */
    note?: string;
}

export interface VaultClipReceiptDto {
    kind: "page" | "video";
    /** The vault note the clip went into, relative to the vault. */
    note: string | null;
    title: string | null;
    error: string | null;
}

export interface VaultAppendInput {
    text: string;
    /** A folder under the vault; default: the inbox folder (`tools hub vault config`). */
    folder?: string;
    /** The note's name without `.md`; default: the inbox note of the day. */
    name?: string;
}

export interface VaultAppendReceiptDto {
    note: string;
}
