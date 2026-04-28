import type { Language, TranscriptSegment } from "@app/youtube/lib/transcript.types";
import type { VideoId } from "@app/youtube/lib/video.types";

export interface FetchCaptionsResult {
    text: string;
    segments: TranscriptSegment[];
    lang: Language;
}

export interface FetchCaptionsOpts {
    videoId: VideoId;
    preferredLangs?: Language[];
}
