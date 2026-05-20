import type { EnrichedQaEntry } from "@app/dev-dashboard/lib/qa-render";
import type { QaEntry } from "@app/question/lib/types";
import { playDingInBrowser } from "@app/utils/audio/runner.client";
import { SafeJSON } from "@app/utils/json";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { LiveSseIndicator } from "@/components/LiveSseIndicator";

interface AudioEntry {
    id: string;
    label: string;
    kind: "bundled" | "synth";
    isDefault: boolean;
}
interface AudioLib {
    bundled: AudioEntry[];
    synth: AudioEntry[];
    default: AudioEntry;
}

function previewSound(id: string, vol: number): void {
    if (id.startsWith("synth:")) {
        playDingInBrowser(id.slice("synth:".length), vol);
        return;
    }

    const audio = new Audio(`/api/qa/sound?id=${encodeURIComponent(id)}`);
    audio.volume = Math.max(0, Math.min(1, vol));
    void audio.play();
}

function SoundControl() {
    const { data: lib } = useQuery<AudioLib>({
        queryKey: ["qa-audio-library"],
        queryFn: async () => {
            const r = await fetch("/api/qa/audio-library");
            return (await r.json()) as AudioLib;
        },
    });
    const [id, setId] = useState<string | null>(null);
    const [vol, setVol] = useState(0.6);
    const [saved, setSaved] = useState(false);

    const selected = id ?? lib?.default.id ?? "";

    const apply = async (): Promise<void> => {
        await fetch("/api/qa/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: SafeJSON.stringify({ sound: selected, soundVolume: vol }),
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    };

    return (
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--dd-text-muted)]">
            <span>🔔 sound</span>
            <select
                className="rounded border border-[#2a3445] bg-transparent px-2 py-1 text-[var(--dd-text-secondary)]"
                value={selected}
                onChange={(e) => setId(e.target.value)}
            >
                {lib && (
                    <>
                        <optgroup label="Bundled (Kenney CC0)">
                            {lib.bundled.map((e) => (
                                <option key={e.id} value={e.id}>
                                    {e.label}
                                    {e.isDefault ? " (default)" : ""}
                                </option>
                            ))}
                        </optgroup>
                        <optgroup label="Synth presets">
                            {lib.synth.map((e) => (
                                <option key={e.id} value={e.id}>
                                    {e.label}
                                </option>
                            ))}
                        </optgroup>
                    </>
                )}
            </select>
            <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={vol}
                onChange={(e) => setVol(Number.parseFloat(e.target.value))}
            />
            <span>{Math.round(vol * 100)}%</span>
            <button
                type="button"
                className="dd-accent-text"
                disabled={!selected}
                onClick={() => previewSound(selected, vol)}
            >
                ▶ test
            </button>
            <button type="button" className="dd-accent-text" disabled={!selected} onClick={apply}>
                {saved ? "saved ✓" : "apply"}
            </button>
        </div>
    );
}

interface QaRow extends QaEntry, EnrichedQaEntry {
    supersededBy: string | null;
    readAt: number | null;
}

async function fetchQaLog(): Promise<QaRow[]> {
    const res = await fetch("/api/qa/log?limit=100");
    if (!res.ok) {
        throw new Error(`Failed to load Q&A: ${res.status}`);
    }

    const body = SafeJSON.parse(await res.text(), { strict: true }) as { entries: QaRow[] };
    return body.entries;
}

function tagClass(tag: string): string {
    if (tag === "action") {
        return "border-[#3f5530] text-[#a3e635]";
    }

    if (tag === "directive") {
        return "border-[#4a3a5e] text-[#c792ea]";
    }

    return "border-[#2a3445] text-[var(--dd-text-secondary)]";
}

function QaCard({ entry, defaultOpen = true }: { entry: QaRow; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    const when = new Date(entry.ts).toISOString().slice(0, 16).replace("T", " ");
    const lines = entry.answerMd.split("\n");
    const truncated = lines.length > 3;
    const answerHtml = open || !truncated ? entry.answerHtml : entry.answerHtmlPreview;

    return (
        <div className="dd-panel flex flex-col gap-2 p-4" data-qa-id={entry.id}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--dd-text-muted)]">
                <span className="text-[var(--dd-text-secondary)]">{entry.project}</span>
                <span>·</span>
                <span>{entry.branch ?? "-"}</span>
                <span className={`rounded-full border px-2 py-[1px] ${tagClass(entry.tag)}`}>{entry.tag}</span>
                <span className="ml-auto">{when}</span>
            </div>
            <div className="font-bold text-[var(--dd-text-primary)]">❯ {entry.question}</div>
            <article className="dd-markdown text-sm" dangerouslySetInnerHTML={{ __html: answerHtml }} />
            {truncated ? (
                <button type="button" className="dd-accent-text self-start text-xs" onClick={() => setOpen((v) => !v)}>
                    {open ? "▴ collapse" : "▾ expand full answer (rationale · refs · links)"}
                </button>
            ) : null}
            {entry.refs.length > 0 ? (
                <div className="text-xs text-[var(--dd-text-muted)]">
                    refs: {entry.refs.map((r) => `${r.type}:${r.value}`).join(" · ")}
                </div>
            ) : null}
        </div>
    );
}

export function QaRoute() {
    const logQuery = useQuery({ queryKey: ["qa-log"], queryFn: fetchQaLog, retry: false });
    const [live, setLive] = useState<QaRow[]>([]);
    const [sseDown, setSseDown] = useState(false);
    const seen = useRef<Set<string>>(new Set());

    useEffect(() => {
        const es = new EventSource("/api/qa/stream");
        es.onopen = () => setSseDown(false);
        es.onmessage = (ev) => {
            setSseDown(false);
            try {
                const entry = SafeJSON.parse(ev.data, { strict: true }) as QaRow;
                if (seen.current.has(entry.id)) {
                    return;
                }

                seen.current.add(entry.id);
                setLive((prev) => [entry, ...prev]);
            } catch {
                /* ignore malformed frame */
            }
        };
        es.onerror = () => setSseDown(true);
        return () => es.close();
    }, []);

    if (logQuery.isError) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-2 text-center">
                <p className="text-lg font-bold text-[#f87171]">Failed to load Q&A</p>
                <p className="max-w-sm text-sm text-[var(--dd-text-secondary)]">
                    {logQuery.error instanceof Error ? logQuery.error.message : String(logQuery.error)}
                </p>
            </div>
        );
    }

    const persisted = (logQuery.data ?? []).filter((r) => !seen.current.has(r.id));
    const all = [...live, ...persisted];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="dd-accent-text text-xl font-bold">Q&amp;A</h2>
                <SoundControl />
                <LiveSseIndicator live={!sseDown} count={all.length} />
            </div>

            {logQuery.isLoading ? (
                <div className="dd-panel py-8 text-center text-sm text-[var(--dd-text-muted)]">Loading Q&amp;A…</div>
            ) : all.length === 0 ? (
                <div className="dd-panel py-8 text-center text-sm text-[var(--dd-text-muted)]">
                    No questions recorded yet.
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {all.map((entry) => (
                        <QaCard key={entry.id} entry={entry} defaultOpen={live.some((row) => row.id === entry.id)} />
                    ))}
                </div>
            )}
        </div>
    );
}
