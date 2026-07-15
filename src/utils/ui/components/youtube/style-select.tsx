import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "@app/utils/ui/components/select";
import { PresetEditor } from "@app/utils/ui/components/youtube/preset-editor";
import type { PresetKind, PromptPreset } from "@app/youtube/lib/types";
import { Plus } from "lucide-react";
import { useState } from "react";

const NONE_VALUE = "__none__";
const NEW_VALUE = "__new__";

/**
 * Style preset picker (Feature 11). Built-in tones are deliberately NOT
 * duplicated here — they already have a working, separate Tone control
 * (SummaryControlsBar) per the design capsule's DON'T-TOUCH on built-in
 * tone enums; this picker only ever offers "no preset", the user's saved
 * presets for `kind`, and "New preset…" (which swaps to the inline editor).
 */
export function StyleSelect({
    kind,
    presets,
    selectedId,
    onSelect,
    onCreate,
    creating,
    className,
}: {
    kind: PresetKind;
    presets: PromptPreset[];
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    onCreate: (input: { name: string; kind: PresetKind; instructions: string }) => Promise<{ preset: PromptPreset }>;
    creating?: boolean;
    className?: string;
}) {
    const [editing, setEditing] = useState(false);

    if (editing) {
        return (
            <PresetEditor
                kind={kind}
                onBack={() => setEditing(false)}
                onCreated={(id) => {
                    onSelect(id);
                    setEditing(false);
                }}
                onCreate={onCreate}
                creating={creating}
            />
        );
    }

    const value = selectedId !== null ? String(selectedId) : NONE_VALUE;

    return (
        <label
            className={`flex items-center gap-2 font-mono text-[0.65rem] uppercase tracking-[0.2em] text-muted-foreground ${className ?? ""}`}
        >
            Style
            <Select
                value={value}
                onValueChange={(next) => {
                    if (next === NEW_VALUE) {
                        setEditing(true);
                        return;
                    }

                    onSelect(next === NONE_VALUE ? null : Number(next));
                }}
            >
                <SelectTrigger className="h-8 min-w-[10rem] text-sm">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={NONE_VALUE}>No preset</SelectItem>
                    {presets.length > 0 ? <SelectSeparator /> : null}
                    {presets.map((preset) => (
                        <SelectItem key={preset.id} value={String(preset.id)}>
                            {preset.name}
                        </SelectItem>
                    ))}
                    <SelectSeparator />
                    <SelectItem value={NEW_VALUE}>
                        <span className="inline-flex items-center gap-1.5">
                            <Plus className="size-4" /> New preset…
                        </span>
                    </SelectItem>
                </SelectContent>
            </Select>
        </label>
    );
}
