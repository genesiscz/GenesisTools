import { formatDuration } from "@app/utils/format";
import { renderColumns } from "@app/youtube/commands/_shared/columns";
import { renderOrEmit } from "@app/youtube/commands/_shared/render";
import type { ChannelHandle, JobStage, JobTargetKind, TimestampedSummaryEntry, VideoId } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";
import pc from "picocolors";

export interface GlobalFlags {
    json?: boolean;
    clipboard?: boolean;
    silent?: boolean;
    verbose?: boolean;
}

export function normaliseHandle(input: string): ChannelHandle {
    const trimmed = input.trim();
    const match = trimmed.match(/(?:https?:\/\/)?(?:www\.)?youtube\.com\/(@[A-Za-z0-9_.-]+)/);

    if (match) {
        return match[1] as ChannelHandle;
    }

    return (trimmed.startsWith("@") ? trimmed : `@${trimmed}`) as ChannelHandle;
}

export function validateHandle(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? "";

    if (trimmed.length < 2) {
        return "Handle is required";
    }

    if (!/^@?[A-Za-z0-9_.-]+$/.test(trimmed) && !/^https?:\/\/.*youtube\.com\/@[A-Za-z0-9_.-]+/.test(trimmed)) {
        return "Looks invalid — use @name or a YouTube channel URL";
    }

    return undefined;
}

export function extractVideoId(value: string): VideoId | null {
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];

    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) {
            return match[1] as VideoId;
        }
    }

    return null;
}

export function resolveTargetKind(target: string): JobTargetKind {
    if (target.startsWith("@")) {
        return "channel";
    }

    if (target.includes("://")) {
        return "url";
    }

    return "video";
}

export function splitTargets(targets: string[]): string[] {
    return targets.flatMap((target) =>
        target
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
    );
}

export async function resolveTargetsToVideoIds(yt: Youtube, targets: string[]): Promise<VideoId[]> {
    const ids: VideoId[] = [];

    for (const target of splitTargets(targets)) {
        if (target.startsWith("@")) {
            const videos = yt.videos.list({
                channel: normaliseHandle(target),
                limit: 5_000,
                includeShorts: true,
                includeLive: true,
            });
            ids.push(...videos.map((video) => video.id));
            continue;
        }

        const id = extractVideoId(target);
        if (!id) {
            throw new Error(`Unable to resolve video target: ${target}`);
        }

        ids.push(id);
    }

    return [...new Set(ids)];
}

export function toJobStages(values: string[]): JobStage[] {
    const allowed = new Set<JobStage>([
        "discover",
        "metadata",
        "captions",
        "audio",
        "video",
        "transcribe",
        "summarize",
    ]);

    return values.map((value) => {
        if (!allowed.has(value as JobStage)) {
            throw new Error(`Unknown pipeline stage: ${value}`);
        }

        return value as JobStage;
    });
}

export function wrap(value: string, width: number): string {
    const words = value.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";

    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (next.length > width && line) {
            lines.push(line);
            line = word;
            continue;
        }

        line = next;
    }

    if (line) {
        lines.push(line);
    }

    return lines.join("\n");
}

export function formatTimestamp(seconds: number): string {
    const totalMs = Math.round(seconds * 1000);
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const secs = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

export function formatSummary(
    videoId: VideoId,
    result: { short?: string; timestamped?: TimestampedSummaryEntry[] },
    mode: "short" | "timestamped"
): string {
    if (mode === "short") {
        return [pc.bold(videoId), wrap(result.short ?? "", 88)].join("\n");
    }

    const rows = result.timestamped ?? [];

    return [
        pc.bold(videoId),
        renderColumns({
            rows,
            schema: [
                { header: "Start", get: (row) => formatDuration(row.startSec * 1000, "ms", "hms"), minWidth: 8 },
                { header: "End", get: (row) => formatDuration(row.endSec * 1000, "ms", "hms"), minWidth: 8 },
                { header: "Summary", get: (row) => row.text, maxWidth: 80 },
            ],
        }),
    ].join("\n");
}

export async function emitJsonMessage(text: string, json: unknown, flags: GlobalFlags): Promise<void> {
    await renderOrEmit({ text, json, flags });
}
