import { Input } from "@ui/components/input";
import { Search } from "lucide-react";

interface SearchInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
}

export function SearchInput({ value, onChange, placeholder, className }: SearchInputProps) {
    return (
        <div className={`relative min-w-0 w-full ${className ?? ""}`}>
            <Search className="absolute top-1/2 left-2 h-4 w-4 -translate-y-1/2 text-[var(--dd-text-muted)]" />
            <Input
                type="search"
                placeholder={placeholder ?? "Search…"}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full pl-8"
            />
        </div>
    );
}
