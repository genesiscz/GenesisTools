import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { Pipeline } from "@app/youtube/lib/pipeline";
import type { QaService } from "@app/youtube/lib/qa";
import type { SummaryService } from "@app/youtube/lib/summarize";
import type { TranscriptService } from "@app/youtube/lib/transcripts";
import type { DumpedVideoMetadata, ListChannelVideosOpts, ListedVideo } from "@app/youtube/lib/yt-dlp.types";

export interface YoutubeOptions {
    baseDir?: string;
    db?: YoutubeDatabase;
    config?: YoutubeConfig;
    deps?: Partial<YoutubeDeps>;
}

export interface YoutubeDeps {
    listChannelVideos: (opts: ListChannelVideosOpts) => Promise<ListedVideo[]>;
    dumpVideoMetadata: (idOrUrl: string, opts?: { signal?: AbortSignal }) => Promise<DumpedVideoMetadata>;
}

export interface YoutubeServices {
    transcripts: TranscriptService;
    summary: SummaryService;
    qa: QaService;
    pipeline: Pipeline;
}
