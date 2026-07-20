import type { FetchCaptionsOpts, FetchCaptionsResult } from "@app/youtube/lib/captions.types";
import { summarizeJson, traceJobExternalCall } from "@app/youtube/lib/job-activity";
import { logger } from "@genesiscz/utils/logger";
import { type TranscriptResponse, YoutubeTranscript } from "youtube-transcript";

interface TranscriptResponseWithLang extends TranscriptResponse {
    lang?: string;
}

export async function fetchCaptions(opts: FetchCaptionsOpts): Promise<FetchCaptionsResult | null> {
    return traceJobExternalCall(
        {
            action: "youtube-transcript:fetch",
            provider: "youtube-transcript",
            model: opts.videoId,
            prompt: summarizeJson({
                videoId: opts.videoId,
                preferredLangs: opts.preferredLangs ?? null,
            }),
            summarize: (result) =>
                result
                    ? summarizeJson({
                          lang: result.lang,
                          segments: result.segments.length,
                          chars: result.text.length,
                      })
                    : summarizeJson({ hit: false }),
        },
        () => fetchCaptionsInner(opts)
    );
}

async function fetchCaptionsInner(opts: FetchCaptionsOpts): Promise<FetchCaptionsResult | null> {
    const langs = opts.preferredLangs?.length ? opts.preferredLangs : [undefined];

    for (const lang of langs) {
        try {
            const config = lang ? { lang } : undefined;
            const transcript = (await YoutubeTranscript.fetchTranscript(
                opts.videoId,
                config
            )) as TranscriptResponseWithLang[];

            if (!transcript.length) {
                continue;
            }

            const segments = transcript.map((item) => ({
                text: item.text,
                start: item.offset / 1000,
                end: (item.offset + item.duration) / 1000,
            }));

            return {
                text: segments.map((segment) => segment.text).join(" "),
                segments,
                lang: lang ?? transcript[0]?.lang ?? "en",
            };
        } catch (err) {
            logger.debug({ err, videoId: opts.videoId, lang }, "fetchCaptions miss");
        }
    }

    return null;
}
