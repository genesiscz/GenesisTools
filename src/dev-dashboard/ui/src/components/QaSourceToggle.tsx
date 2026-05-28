import { ToggleGroup, ToggleGroupItem } from "@ui/components/toggle-group";
import { BookOpen, FileCode } from "lucide-react";

export type QaViewMode = "reading" | "source";

export function QaSourceToggle({ mode, onChange }: { mode: QaViewMode; onChange: (m: QaViewMode) => void }) {
    return (
        <ToggleGroup
            type="single"
            size="sm"
            value={mode}
            onValueChange={(v) => {
                if (v === "reading" || v === "source") {
                    onChange(v);
                }
            }}
        >
            <ToggleGroupItem value="reading" aria-label="Reading mode">
                <BookOpen className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="source" aria-label="Source mode">
                <FileCode className="h-4 w-4" />
            </ToggleGroupItem>
        </ToggleGroup>
    );
}
