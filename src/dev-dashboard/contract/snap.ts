/**
 * Snap it to the agent (F24). Types only (`contract-purity.test.ts`). The phone uploads a marked-up photo
 * (`POST /api/gateway/upload`), then names the session it is for; the Mac stages it on the widget file shelf and adds
 * it to that session's draft, the same as a Mac screenshot (`POST /api/snap`).
 */

export interface SnapInput {
    /** The path the upload route answered. Only a file the upload route stored is accepted. */
    path: string;
    provider: string;
    sessionId: string;
    /** The session's source home; empty for a native session. */
    sourceHome?: string;
    name?: string;
}

export interface SnapReceiptDto {
    attached: boolean;
    /** The widget draft the image went into (`<host>:<provider>:<session>:<home>`). */
    draftKey: string | null;
    shelfId: string | null;
    error: string | null;
}
