import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@ui/components/command";
import { cn } from "@ui/lib/utils";
import { MapPin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface DistrictsResponse {
    districts: string[];
    praha: string[];
}

interface DistrictSelectorProps {
    value: string;
    onChange: (district: string) => void;
    error?: boolean;
}

export function DistrictSelector({ value, onChange, error }: DistrictSelectorProps) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [data, setData] = useState<DistrictsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetch("/api/districts")
            .then((res) => res.json() as Promise<DistrictsResponse>)
            .then(setData)
            .catch(() => setData({ districts: [], praha: [] }))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }

        if (open) {
            document.addEventListener("mousedown", handleClickOutside);
        }

        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [open]);

    const prahaSet = useMemo(() => new Set(data?.praha ?? []), [data]);

    const regularDistricts = useMemo(() => (data?.districts ?? []).filter((d) => !prahaSet.has(d)), [data, prahaSet]);

    const prahaDistricts = useMemo(() => data?.praha ?? [], [data]);

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className={cn(
                    "flex h-9 w-full items-center justify-between rounded-md border px-3 py-1 text-sm transition-all",
                    "glass-card bg-transparent font-mono",
                    error
                        ? "border-red-500/50 ring-2 ring-red-500/20"
                        : "border-primary/30 focus:border-primary/50 focus:ring-2 focus:ring-primary/30",
                    value ? "text-foreground" : "text-muted-foreground"
                )}
            >
                <span className="flex items-center gap-2 truncate">
                    <MapPin className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    {value || "Select district..."}
                </span>
                <svg
                    className={cn("h-4 w-4 shrink-0 opacity-50 transition-transform", open && "rotate-180")}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    role="img"
                    aria-label="Toggle dropdown"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {open && (
                <div className="absolute z-50 mt-1 w-full rounded-md border border-primary/20 glass-card shadow-lg shadow-black/50 animate-slide-up">
                    <Command className="bg-transparent" shouldFilter={true}>
                        <CommandInput
                            placeholder={loading ? "Loading districts..." : "Search districts..."}
                            value={search}
                            onValueChange={setSearch}
                            className="font-mono text-xs"
                        />
                        <CommandList className="max-h-[240px]">
                            <CommandEmpty className="py-4 text-xs text-muted-foreground font-mono">
                                No districts found
                            </CommandEmpty>

                            {prahaDistricts.length > 0 && (
                                <CommandGroup
                                    heading="Praha"
                                    className="[&_[cmdk-group-heading]]:text-cyan-400 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                                >
                                    {prahaDistricts.map((district) => (
                                        <CommandItem
                                            key={district}
                                            value={district}
                                            onSelect={() => {
                                                onChange(district);
                                                setOpen(false);
                                                setSearch("");
                                            }}
                                            className={cn(
                                                "cursor-pointer font-mono text-xs",
                                                "data-[selected=true]:bg-cyan-500/10 data-[selected=true]:text-cyan-300",
                                                value === district && "text-cyan-400"
                                            )}
                                        >
                                            <MapPin className="mr-1.5 h-3 w-3 text-cyan-400/60" />
                                            {district}
                                            {value === district && (
                                                <span className="ml-auto text-cyan-400">&#10003;</span>
                                            )}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}

                            {regularDistricts.length > 0 && (
                                <CommandGroup
                                    heading="Districts"
                                    className="[&_[cmdk-group-heading]]:text-amber-400 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                                >
                                    {regularDistricts.map((district) => (
                                        <CommandItem
                                            key={district}
                                            value={district}
                                            onSelect={() => {
                                                onChange(district);
                                                setOpen(false);
                                                setSearch("");
                                            }}
                                            className={cn(
                                                "cursor-pointer font-mono text-xs",
                                                "data-[selected=true]:bg-amber-500/10 data-[selected=true]:text-amber-300",
                                                value === district && "text-amber-400"
                                            )}
                                        >
                                            <MapPin className="mr-1.5 h-3 w-3 text-amber-400/60" />
                                            {district}
                                            {value === district && (
                                                <span className="ml-auto text-amber-400">&#10003;</span>
                                            )}
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}
                        </CommandList>
                    </Command>
                </div>
            )}
        </div>
    );
}
