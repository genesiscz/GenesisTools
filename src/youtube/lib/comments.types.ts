import type { VideoId } from "@app/youtube/lib/video.types";

export interface VideoComment {
    id: number;
    videoId: VideoId;
    commentId: string;
    author: string | null;
    authorId: string | null;
    text: string;
    likeCount: number | null;
    publishedAt: string | null;
    parentCommentId: string | null;
    createdAt: string;
}

export interface FetchCommentsOpts {
    max?: number;
    signal?: AbortSignal;
}

export interface FetchedComment {
    commentId: string;
    author: string | null;
    authorId: string | null;
    text: string;
    likeCount: number | null;
    publishedAt: string | null;
    parentCommentId: string | null;
}
