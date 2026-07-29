import type { JSONValue } from "@ai-sdk/provider";
import type { TranscriptionSegment } from "../types";
import { cleanRepetitions } from "./repetition-cleanup";
import { normalizeSpeakerLabel } from "./speaker-label";

/**
 * Everything that turns an ai-sdk `transcribe()` result into ours.
 *
 * It used to live inside `TranscriptionManager` as private methods, which meant
 * the moment a second caller existed (`ai.transcribe`, going through provider
 * bindings) the sentence-rebuilding and the Deepgram utterance dig would have
 * been copied rather than shared — and the copies would have drifted, because
 * the reasons they exist are subtle enough that nobody re-derives them.
 */

interface SdkTranscriptionResult {
    text: string;
    segments?: ReadonlyArray<{ text: string; startSecond: number; endSecond: number }>;
    language?: string;
    durationInSeconds?: number;
    responses?: ReadonlyArray<unknown>;
}

interface DeepgramUtterance {
    speaker: number;
    transcript: string;
    start: number;
    end: number;
}

interface DeepgramRawResponse {
    body?: { results?: { utterances?: DeepgramUtterance[] } };
}

/**
 * Deepgram's `diarize+utterances` puts speaker-grouped sentence segments in
 * the *raw* provider response (`responses[0].body.results.utterances`) — the
 * AI SDK does not surface them. Pull them out with narrow typed access (no
 * `any`); speaker ids are normalized through the single label source.
 */
export function deepgramUtteranceSegments(result: {
    responses?: ReadonlyArray<unknown>;
}): TranscriptionSegment[] | undefined {
    const first = result.responses?.[0] as DeepgramRawResponse | undefined;
    const utts = first?.body?.results?.utterances;

    if (!utts?.length) {
        return undefined;
    }

    return utts.map((u) => ({
        text: u.transcript,
        start: u.start,
        end: u.end,
        speaker: normalizeSpeakerLabel(u.speaker),
    }));
}

/**
 * Rebuild sentence-level segments from a formatted transcript + word timings.
 *
 * Some providers (Deepgram via `@ai-sdk/deepgram`) only expose per-word
 * segments containing the *raw, lowercase, unpunctuated* token — the
 * smart-formatted text exists solely as `result.text`. We recover usable
 * subtitle cues by splitting `result.text` into sentences and distributing
 * them across the word timings proportionally (robust to token-count drift
 * from smart-formatting, since it never assumes a 1:1 word↔segment match).
 */
function rebuildSentenceSegments(text: string, wordSegments: TranscriptionSegment[]): TranscriptionSegment[] {
    const sentences =
        text
            .match(/[^.!?…]+[.!?…]+["')\]]*|\S[^.!?…]*$/g)
            ?.map((s) => s.trim())
            .filter(Boolean) ?? [];

    const wordCounts = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
    const totalWords = wordCounts.reduce((a, b) => a + b, 0);
    const n = wordSegments.length;

    if (sentences.length === 0 || totalWords === 0 || n === 0) {
        return wordSegments;
    }

    const out: TranscriptionSegment[] = [];
    let cum = 0;

    for (let i = 0; i < sentences.length; i++) {
        const startIdx = Math.min(n - 1, Math.floor((cum / totalWords) * n));
        cum += wordCounts[i];
        const endIdx = Math.min(n - 1, Math.max(startIdx, Math.ceil((cum / totalWords) * n) - 1));
        out.push({
            text: sentences[i],
            start: wordSegments[startIdx].start,
            end: wordSegments[endIdx].end,
        });
    }

    return out;
}

/** Map an AI SDK transcription result to our segment shape, recovering
 * sentence cues for word-level providers. */
export function mapResultSegments(result: SdkTranscriptionResult): TranscriptionSegment[] | undefined {
    if (!result.segments?.length) {
        return undefined;
    }

    const segments: TranscriptionSegment[] = result.segments.map((seg) => ({
        text: seg.text,
        start: seg.startSecond,
        end: seg.endSecond,
    }));

    const singleWord = segments.filter((s) => !/\s/.test(s.text.trim())).length;

    if (result.text && segments.length > 1 && singleWord / segments.length > 0.7) {
        return rebuildSentenceSegments(result.text, segments);
    }

    return segments;
}

/**
 * The full text+segments mapping for one SDK result: Deepgram's speaker-grouped
 * utterances when it diarized, plain segment mapping otherwise, then repetition
 * cleanup unless the caller turned it off.
 */
export function mapSdkTranscription(opts: {
    result: SdkTranscriptionResult;
    provider: string;
    diarize?: boolean;
    clean?: boolean;
}): { text: string; segments?: TranscriptionSegment[] } {
    const { result, provider } = opts;
    const mapped =
        provider === "deepgram" && opts.diarize
            ? (deepgramUtteranceSegments(result) ?? mapResultSegments(result))
            : mapResultSegments(result);

    if (opts.clean === false) {
        return { text: result.text, segments: mapped };
    }

    return cleanRepetitions({ text: result.text, segments: mapped });
}

export interface TranscriptionProviderOptionInput {
    language?: string;
    diarize?: boolean;
    speakers?: number;
}

/**
 * Build provider-specific options for the AI SDK `transcribe()` call.
 *
 * The AI SDK has NO top-level `language` parameter — a language hint only
 * reaches the model through `providerOptions.<providerId>.language`.
 * Passing it anywhere else is silently dropped, which makes Whisper
 * auto-detect per 30s window and hallucinate/loop on non-English audio.
 * So `language` MUST be threaded here for every provider.
 *
 * The outer key is the AI SDK *provider id*, not our internal name:
 * `openrouter` is created via `createOpenAI(...)` so its id is `openai`.
 */
export function buildTranscriptionProviderOptions(
    provider: string,
    options: TranscriptionProviderOptionInput
): Record<string, Record<string, JSONValue>> {
    const result: Record<string, Record<string, JSONValue>> = {};
    const lang = options.language;

    if (provider === "openai" || provider === "openrouter" || provider === "groq") {
        // whisper-based; keys are camelCase per AI SDK. temperature:0 is the
        // documented anti-hallucination setting; segment timestamps power SRT/VTT.
        const opts: Record<string, JSONValue> = {
            temperature: 0,
            timestampGranularities: ["segment"],
        };

        if (lang) {
            opts.language = lang;
        }

        // openrouter uses the openai-compatible provider instance → id "openai"
        const key = provider === "groq" ? "groq" : "openai";
        result[key] = opts;
    }

    if (provider === "deepgram") {
        const deepgramOpts: Record<string, JSONValue> = {
            // Smart Format implies punctuation + capitalization + numerals;
            // without it Deepgram returns lowercase unpunctuated text.
            smartFormat: true,
            punctuate: true,
        };

        if (lang) {
            deepgramOpts.language = lang;
        } else {
            deepgramOpts.detectLanguage = true;
        }

        if (options.diarize) {
            deepgramOpts.diarize = true;
            deepgramOpts.utterances = true; // gives speaker-grouped sentence segments
        }

        result.deepgram = deepgramOpts;
    }

    if (provider === "assemblyai") {
        const assemblyaiOpts: Record<string, JSONValue> = {};

        if (lang) {
            assemblyaiOpts.languageCode = lang;
        }

        if (options.diarize) {
            assemblyaiOpts.speakerLabels = true;
        }

        if (Object.keys(assemblyaiOpts).length > 0) {
            result.assemblyai = assemblyaiOpts;
        }
    }

    // Local runtimes read their hints off the same record through
    // `toTranscriptionModel` (providers/transcription-adapter.ts), which is why
    // this is keyed by plugin id and not by SDK vendor alone.
    if (provider === "local-hf" || provider === "xai") {
        const localOpts: Record<string, JSONValue> = {};

        if (lang) {
            localOpts.language = lang;
        }

        if (options.diarize) {
            localOpts.diarize = true;
        }

        if (options.speakers) {
            localOpts.speakers = options.speakers;
        }

        if (Object.keys(localOpts).length > 0) {
            result[provider] = localOpts;
        }
    }

    return result;
}
