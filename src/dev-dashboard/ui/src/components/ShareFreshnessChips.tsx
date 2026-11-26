import type { ShareTargetStatusDto } from "@app/dev-dashboard/contract/endpoints";
import {
    type FreshnessTone,
    formatAgo,
    freshnessTone,
    isEditedAfterSync,
} from "@app/dev-dashboard/lib/share/freshness";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const TONE_COLOR: Record<FreshnessTone, string> = {
    fresh: "var(--dd-tone-fresh)",
    recent: "var(--dd-tone-recent)",
    aging: "var(--dd-tone-aging)",
    stale: "var(--dd-tone-stale)",
};

/** The current time: each second while the newest time is under a minute old ("25 s ago"), once a minute after. */
function useAgeClock(newest: number | undefined): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const age = newest === undefined ? Number.POSITIVE_INFINITY : now - newest;
        const id = setTimeout(() => setNow(Date.now()), age < 60_000 ? 1000 : 60_000);

        return () => clearTimeout(id);
    }, [now, newest]);

    return now;
}

function localTime(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface ChipView {
    label: string;
    tone: FreshnessTone;
    pulse: boolean;
    stale: boolean;
    title: string;
}

/** What one chip says: a live place by the note's last edit, a synced one by its last sync. */
export function chipView(share: ShareTargetStatusDto, editedAt: string | null, now: number): ChipView {
    if (share.live) {
        return {
            label: `${share.target}, live`,
            tone: editedAt ? freshnessTone(now - Date.parse(editedAt)) : "stale",
            pulse: true,
            stale: false,
            title: editedAt ? `Served live from this Mac. Edited ${localTime(editedAt)}` : "Served live from this Mac",
        };
    }

    if (!share.syncedAt || !share.sourceModifiedAt) {
        return {
            label: `${share.target}, synced`,
            tone: "stale",
            pulse: false,
            stale: false,
            title: "Sent before sync times were recorded; share sync records one",
        };
    }

    const stale = isEditedAfterSync(editedAt ?? undefined, {
        syncedAt: share.syncedAt,
        sourceModifiedAt: share.sourceModifiedAt,
    });

    return {
        label: stale
            ? `${share.target}, edited after the last sync`
            : `${share.target}, synced ${formatAgo(now - Date.parse(share.syncedAt))}`,
        tone: stale ? "aging" : freshnessTone(now - Date.parse(share.syncedAt)),
        pulse: false,
        stale,
        title: [
            `Synced ${localTime(share.syncedAt)}`,
            `Version from ${localTime(share.sourceModifiedAt)}`,
            editedAt ? `Edited ${localTime(editedAt)}` : "",
        ]
            .filter(Boolean)
            .join("\n"),
    };
}

function CopyLink({ url, target }: { url: string; target: string }) {
    const [copied, setCopied] = useState(false);

    return (
        <button
            type="button"
            className="rounded p-0.5 text-[var(--dd-text-muted)] hover:bg-[var(--dd-bg-hover)] hover:text-[var(--dd-text-primary)]"
            aria-label={`Copy the ${target} link`}
            title={url}
            onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            }}
        >
            {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
    );
}

/** One chip per place a published note is served from, coloured by how fresh that place's copy is. */
export function ShareFreshnessChips({ shares, editedAt }: { shares: ShareTargetStatusDto[]; editedAt: string | null }) {
    const times = shares.flatMap((share) => (share.syncedAt ? [Date.parse(share.syncedAt)] : []));
    const now = useAgeClock(times.length ? Math.max(...times) : undefined);

    return (
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">
            {shares.map((share) => {
                const view = chipView(share, editedAt, now);
                const color = TONE_COLOR[view.tone];

                return (
                    <span
                        key={share.target}
                        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] whitespace-nowrap text-[var(--dd-text-primary)]"
                        style={{
                            borderColor: `color-mix(in srgb, ${color} 45%, var(--dd-border))`,
                            background: `color-mix(in srgb, ${color} 10%, transparent)`,
                        }}
                        title={view.title}
                        data-tone={view.tone}
                        data-stale={view.stale || undefined}
                    >
                        <span
                            aria-hidden="true"
                            className={`size-1.5 rounded-full${view.pulse ? " motion-safe:animate-pulse" : ""}`}
                            style={{ background: color }}
                        />
                        {view.label}
                        <CopyLink url={share.url} target={share.target} />
                    </span>
                );
            })}
        </div>
    );
}
