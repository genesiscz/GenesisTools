import { SegmentedControl } from "@ui/components/segmented-control";
import { BookOpen, FileCode } from "lucide-react";

export type QaViewMode = "reading" | "source";

export function QaSourceToggle({ mode, onChange }: { mode: QaViewMode; onChange: (m: QaViewMode) => void }) {
    return (
        <SegmentedControl
            tone="dd"
            aria-label="View mode"
            layout="icon"
            value={mode}
            onValueChange={onChange}
            options={[
                { value: "reading", label: <BookOpen className="h-4 w-4" />, "aria-label": "Reading mode" },
                { value: "source", label: <FileCode className="h-4 w-4" />, "aria-label": "Source mode" },
            ]}
        />
    );
}
