import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import type { PresetKind, PromptPreset } from "@app/youtube/lib/types";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * Verbatim inline preset editor per
 * 2026-07-15-RoadmapFeature11-PromptPersonas.plan.md — adapted only to take
 * `onCreate`/`creating` as props instead of calling the extension-specific
 * `useCreatePreset()` hook directly, so this stays a host-agnostic shared
 * component (same pattern as `ShareButton`'s `onShare` prop).
 */
export function PresetEditor({
    kind,
    onBack,
    onCreated,
    onCreate,
    creating,
}: {
    kind: PresetKind;
    onBack: () => void;
    onCreated: (id: number) => void;
    onCreate: (input: { name: string; kind: PresetKind; instructions: string }) => Promise<{ preset: PromptPreset }>;
    creating?: boolean;
}) {
    const [name, setName] = useState("");
    const [instructions, setInstructions] = useState("");
    const [error, setError] = useState<string | null>(null);
    const over = instructions.length > 1000;

    async function save() {
        setError(null);
        try {
            const { preset } = await onCreate({ name: name.trim(), kind, instructions });
            onCreated(preset.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <div className="space-y-3">
            <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
                <ArrowLeft className="size-4" /> Back
            </button>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">New style preset</p>
            <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Skeptic mode"
                className="h-9 text-sm"
            />
            <div className="relative">
                <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="List every claim the speaker makes and rate the evidence given for it…"
                    className="min-h-24 w-full resize-y rounded-lg border border-white/8 bg-black/20 p-2.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
                />
                <span
                    className={`pointer-events-none absolute bottom-2 right-2.5 font-mono text-[12px] tabular-nums ${
                        over ? "text-destructive/90" : "text-muted-foreground"
                    }`}
                >
                    {instructions.length}/1000
                </span>
            </div>
            {error ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">{error}</p>
                </div>
            ) : null}
            <Button
                size="sm"
                className="w-full"
                disabled={creating || name.trim() === "" || instructions.trim() === "" || over}
                onClick={() => void save()}
            >
                {creating ? <Loader2 className="size-4 animate-spin" /> : null} Save preset
            </Button>
        </div>
    );
}
