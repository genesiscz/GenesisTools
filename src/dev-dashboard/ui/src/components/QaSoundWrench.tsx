import { playDingInBrowser } from "@app/utils/audio/runner.client";
import { SafeJSON } from "@app/utils/json";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { IconPopover } from "@ui/components/icon-button";
import { Wrench } from "lucide-react";
import { useState } from "react";

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

export function QaSoundWrench() {
    const { data: lib } = useQuery<AudioLib>({
        queryKey: ["qa-audio-library"],
        queryFn: async () => {
            const r = await fetch("/api/qa/audio-library");

            if (!r.ok) {
                throw new Error(`audio-library: ${r.status}`);
            }

            return r.json() as Promise<AudioLib>;
        },
    });
    const [id, setId] = useState<string | null>(null);
    const [vol, setVol] = useState(0.6);
    const [saved, setSaved] = useState(false);
    const selected = id ?? lib?.default.id ?? "";

    const apply = async (): Promise<void> => {
        try {
            const res = await fetch("/api/qa/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ sound: selected, soundVolume: vol }),
            });

            if (!res.ok) {
                return;
            }

            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch {
            return;
        }
    };

    return (
        <IconPopover
            tooltip="Audio settings"
            align="end"
            contentClassName="flex w-80 flex-col gap-3"
            trigger={
                <Button
                    variant="ghost"
                    size="icon"
                    className="text-[var(--dd-text-muted)] hover:text-[var(--dd-text-secondary)]"
                >
                    <Wrench className="h-4 w-4" />
                </Button>
            }
        >
            <div className="text-xs uppercase tracking-wider text-[var(--dd-text-muted)]">Notification sound</div>
            <select
                className="rounded border border-[var(--dd-border)] bg-transparent px-2 py-1 text-sm text-[var(--dd-text-secondary)]"
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
            <div className="flex items-center gap-2">
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={vol}
                    onChange={(e) => setVol(Number.parseFloat(e.target.value))}
                    className="flex-1 accent-cyan-400"
                />
                <span className="w-10 text-right font-mono text-xs tabular-nums">{Math.round(vol * 100)}%</span>
            </div>
            <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" disabled={!selected} onClick={() => previewSound(selected, vol)}>
                    Test
                </Button>
                <Button size="sm" disabled={!selected} onClick={apply}>
                    {saved ? "Saved ✓" : "Apply"}
                </Button>
            </div>
        </IconPopover>
    );
}
