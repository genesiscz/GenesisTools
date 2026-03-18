import { SafeJSON } from "@app/utils/json";
import type { TranscriptionResult } from "./types";

export type OutputFormat = "text" | "json" | "srt" | "vtt";

export function formatTimestamp(seconds: number, separator: "," | "."): string {
    const totalMs = Math.round(seconds * 1000);
    const h = Math.floor(totalMs / 3_600_000);
    const m = Math.floor((totalMs % 3_600_000) / 60_000);
    const s = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;

    return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad3(ms)}`;
}

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

function pad3(n: number): string {
    return String(n).padStart(3, "0");
}

export function toSRT(result: TranscriptionResult): string {
    if (!result.segments?.length) {
        return result.text;
    }

    return result.segments
        .map((seg, i) => {
            const start = formatTimestamp(seg.start, ",");
            const end = formatTimestamp(seg.end, ",");
            return `${i + 1}\n${start} --> ${end}\n${seg.text.trim()}`;
        })
        .join("\n\n");
}

export function toVTT(result: TranscriptionResult): string {
    if (!result.segments?.length) {
        return `WEBVTT\n\n${result.text}`;
    }

    const cues = result.segments
        .map((seg) => {
            const start = formatTimestamp(seg.start, ".");
            const end = formatTimestamp(seg.end, ".");
            return `${start} --> ${end}\n${seg.text.trim()}`;
        })
        .join("\n\n");

    return `WEBVTT\n\n${cues}`;
}

export function formatOutput(result: TranscriptionResult, format: OutputFormat): string {
    switch (format) {
        case "text":
            return result.text;
        case "json":
            return SafeJSON.stringify(result, null, 2);
        case "srt":
            return toSRT(result);
        case "vtt":
            return toVTT(result);
    }
}
