export type ShareKind = "summary" | "qa";

export interface ShareSummary {
    slug: string;
    url: string;
    kind: ShareKind;
    videoId: string;
    videoTitle: string;
    createdAt: string;
    revokedAt: string | null;
}
