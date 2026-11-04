import type { TransclusionToken } from "@genesiscz/utils/transclude/types";

/**
 * The transclusion shapes of a question item, with no runtime code: the phone's contract types reach them through
 * the pending form types, so they must not pull the transclusion engine and its file readers into its type check.
 */

/** One token of an item, with the field it was written in (`promptMarkdown`, `reasoning`, `choices[1]`). */
export type FieldTransclusion = TransclusionToken & { field: string };

/** Set on an item whose text changed: the fields as written, and every token. */
export interface ItemTransclusion {
    source: { promptMarkdown?: string; reasoning?: string; proposal?: string; choices?: string[] };
    tokens: FieldTransclusion[];
}
