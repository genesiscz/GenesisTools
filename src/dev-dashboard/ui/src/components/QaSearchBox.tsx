import { Input } from "@ui/components/input";
import { Search } from "lucide-react";

export function QaSearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return (
        <div className="relative min-w-0 w-full">
            <Search className="absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2 text-[var(--dd-text-muted)]" />
            <Input
                type="search"
                placeholder="Search Q&A — any field, fuzzy (commit-1c0, file:foo.ts, etc.)"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full pl-8"
            />
        </div>
    );
}
