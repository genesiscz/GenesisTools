import { CompactRenderer } from "./compact";
import { EventsRenderer } from "./events";
import { JsonlRenderer, JsonRenderer } from "./json";
import { RawRenderer } from "./raw";
import type { TranscriptFormat, TranscriptRenderer } from "./renderer";

export { CompactRenderer, formatTotals, oneLine } from "./compact";
export { EventsRenderer, turnToWorkerEvents } from "./events";
export { JsonlRenderer, JsonRenderer } from "./json";
export { RawRenderer } from "./raw";
export type { RenderContext, ThoughtMode, TranscriptFormat } from "./renderer";
export {
    defaultRenderContext,
    isThoughtMode,
    isTranscriptFormat,
    settledTurns,
    THOUGHT_MODES,
    TRANSCRIPT_FORMATS,
    TranscriptRenderer,
    windowStart,
} from "./renderer";

/** A fresh renderer per invocation: each one keeps what it already printed. */
export function rendererFor(format: TranscriptFormat): TranscriptRenderer {
    switch (format) {
        case "compact":
            return new CompactRenderer();
        case "json":
            return new JsonRenderer();
        case "jsonl":
            return new JsonlRenderer();
        case "events":
            return new EventsRenderer();
        case "raw":
            return new RawRenderer();
    }
}
