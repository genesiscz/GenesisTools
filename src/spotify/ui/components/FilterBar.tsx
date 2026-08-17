/**
 * The header controls that decide whose data every page shows, and over what window.
 * Nothing else in the dashboard owns a profile picker.
 */
import { useFilters } from "@app/spotify/ui/lib/filters";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { CalendarRange, RotateCcw, User } from "lucide-react";

const ALL_TIME = "__all__";

export function FilterBar() {
    const { filters, setFilters, reset, profiles, activeProfile, windowLabel } = useFilters();
    const rows = profiles.data?.profiles ?? [];
    const years = Array.from({ length: 14 }, (_, i) => String(new Date().getFullYear() - i));

    return (
        <div className="flex items-center gap-2">
            <Select
                value={activeProfile?.name ?? ""}
                onValueChange={(name) => setFilters({ profile: name })}
                disabled={!rows.length}
            >
                <SelectTrigger className="h-8 w-[140px] text-xs" aria-label="Profile">
                    <User className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
                    <SelectValue placeholder="profile" />
                </SelectTrigger>
                <SelectContent>
                    {rows.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                            {p.label || p.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <Popover>
                <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 text-xs font-mono">
                        <CalendarRange className="h-3.5 w-3.5 mr-1" />
                        {windowLabel}
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 space-y-3">
                    <div className="space-y-1">
                        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Year</div>
                        <Select
                            value={filters.year || ALL_TIME}
                            onValueChange={(y) => setFilters({ year: y === ALL_TIME ? "" : y })}
                        >
                            <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL_TIME}>all time</SelectItem>
                                {years.map((y) => (
                                    <SelectItem key={y} value={y}>
                                        {y}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-1">
                        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                            Or an explicit range
                        </div>
                        <div className="flex items-center gap-2">
                            <Input
                                type="date"
                                value={filters.since}
                                onChange={(e) => setFilters({ since: e.target.value })}
                                className="h-8 text-xs"
                                aria-label="Since"
                            />
                            <Input
                                type="date"
                                value={filters.until}
                                onChange={(e) => setFilters({ until: e.target.value })}
                                className="h-8 text-xs"
                                aria-label="Until"
                            />
                        </div>
                    </div>

                    <Button variant="ghost" size="sm" className="w-full h-8 text-xs" onClick={reset}>
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />
                        Reset to all time
                    </Button>
                </PopoverContent>
            </Popover>
        </div>
    );
}
