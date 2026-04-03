import { DISPOSITIONS } from "@app/Internal/commands/reas/lib/config-builder";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { DistrictCommandSelect } from "@ui/components/command";
import { DateRangePicker } from "@ui/components/date-range-picker";
import { Input } from "@ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Filter } from "lucide-react";
import type { FormEvent, HTMLInputTypeAttribute } from "react";
import type { ListingsFilters, SortBy, SortDir } from "./listings-shared";

const DISPOSITION_OPTIONS = DISPOSITIONS.filter((option) => option.value !== "all");

export function ListingFilters({
    filters,
    sourceOptions,
    sortBy,
    sortDir,
    totalPages,
    page,
    onDistrictChange,
    onToggleDisposition,
    onToggleSource,
    onDateRangeChange,
    onNumberFilterChange,
    onSubmit,
    onReset,
    onSortByChange,
    onSortDirChange,
    sortOptions,
}: {
    filters: ListingsFilters;
    sourceOptions: string[];
    sortBy: SortBy;
    sortDir: SortDir;
    totalPages: number;
    page: number;
    onDistrictChange: (value: string) => void;
    onToggleDisposition: (value: string) => void;
    onToggleSource: (value: string) => void;
    onDateRangeChange: (range: { from: string; to: string }) => void;
    onNumberFilterChange: (key: "priceMin" | "priceMax" | "areaMin" | "areaMax", value: string) => void;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    onReset: () => void;
    onSortByChange: (value: SortBy) => void;
    onSortDirChange: (value: SortDir) => void;
    sortOptions: Array<{ value: SortBy; label: string }>;
}) {
    return (
        <Card className="mb-6 border-white/5 bg-white/[0.02]">
            <CardHeader className="border-b border-white/5 pb-4">
                <CardTitle className="flex items-center gap-2 font-mono text-sm text-amber-300">
                    <Filter className="h-4 w-4" />
                    Filters
                </CardTitle>
                <CardDescription className="font-mono text-xs text-gray-500">
                    Narrow the browser by district, disposition mix, providers, pricing bands, and seen window.
                </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
                <form className="flex flex-col gap-4" onSubmit={onSubmit}>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <div className="block">
                            <span className="mb-1.5 block text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">
                                District
                            </span>
                            <DistrictCommandSelect
                                value={filters.district}
                                onValueChange={onDistrictChange}
                                placeholder="Select district..."
                                shouldFilter={false}
                            />
                        </div>
                        <FilterMultiSelect
                            label="Dispositions"
                            emptyLabel="Any disposition"
                            selectedValues={filters.dispositions}
                            options={DISPOSITION_OPTIONS.map((option) => ({
                                value: option.value,
                                label: option.label,
                            }))}
                            onToggle={onToggleDisposition}
                        />
                        <FilterMultiSelect
                            label="Sources"
                            emptyLabel="Any provider"
                            selectedValues={filters.sources}
                            options={sourceOptions.map((source) => ({ value: source, label: source }))}
                            onToggle={onToggleSource}
                        />
                        <SelectField label="Sort by" value={sortBy} onChange={onSortByChange} options={sortOptions} />
                        <div className="grid grid-cols-2 gap-3">
                            <FilterInput
                                label="Min price"
                                value={filters.priceMin}
                                onChange={(value) => onNumberFilterChange("priceMin", value)}
                                placeholder="2500000"
                                type="number"
                            />
                            <FilterInput
                                label="Max price"
                                value={filters.priceMax}
                                onChange={(value) => onNumberFilterChange("priceMax", value)}
                                placeholder="8000000"
                                type="number"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <FilterInput
                                label="Min area"
                                value={filters.areaMin}
                                onChange={(value) => onNumberFilterChange("areaMin", value)}
                                placeholder="45"
                                type="number"
                            />
                            <FilterInput
                                label="Max area"
                                value={filters.areaMax}
                                onChange={(value) => onNumberFilterChange("areaMax", value)}
                                placeholder="120"
                                type="number"
                            />
                        </div>
                        <SelectField
                            label="Direction"
                            value={sortDir}
                            onChange={onSortDirChange}
                            options={[
                                { value: "desc", label: "Descending" },
                                { value: "asc", label: "Ascending" },
                            ]}
                        />
                    </div>

                    <div className="rounded-xl border border-white/5 bg-black/20 p-3">
                        <span className="mb-3 block text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">
                            Seen date range
                        </span>
                        <DateRangePicker
                            value={{ from: filters.seenFrom, to: filters.seenTo }}
                            onChange={onDateRangeChange}
                        />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-4">
                        <p className="font-mono text-[11px] text-gray-500">
                            Page {page} of {totalPages}
                        </p>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                className="border-white/10 bg-white/[0.02] text-gray-300 hover:bg-white/[0.04]"
                                onClick={onReset}
                            >
                                Reset
                            </Button>
                            <Button
                                type="submit"
                                className="border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                            >
                                Apply filters
                            </Button>
                        </div>
                    </div>
                </form>
            </CardContent>
        </Card>
    );
}

function FilterInput({
    label,
    value,
    onChange,
    placeholder,
    type = "text",
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    type?: HTMLInputTypeAttribute;
}) {
    return (
        <div className="block">
            <span className="mb-1.5 block text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">{label}</span>
            <Input
                type={type}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                className="border-white/10 bg-black/20 font-mono text-xs text-gray-200 placeholder:text-gray-600"
            />
        </div>
    );
}

function FilterMultiSelect({
    label,
    emptyLabel,
    selectedValues,
    options,
    onToggle,
}: {
    label: string;
    emptyLabel: string;
    selectedValues: string[];
    options: Array<{ value: string; label: string }>;
    onToggle: (value: string) => void;
}) {
    return (
        <div className="block">
            <span className="mb-1.5 block text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">{label}</span>
            <Popover>
                <PopoverTrigger asChild>
                    <Button
                        type="button"
                        variant="outline"
                        className="w-full justify-between border-white/10 bg-black/20 font-mono text-xs text-gray-200 hover:bg-white/[0.04]"
                    >
                        <span className="truncate">{getMultiSelectLabel({ selectedValues, emptyLabel })}</span>
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 border-white/10 bg-[#09090d] p-3">
                    <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                        {options.map((option) => {
                            const checked = selectedValues.includes(option.value);

                            return (
                                <label
                                    key={option.value}
                                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs font-mono text-gray-200 hover:bg-white/[0.04]"
                                >
                                    <Checkbox checked={checked} onCheckedChange={() => onToggle(option.value)} />
                                    <span>{option.label}</span>
                                </label>
                            );
                        })}
                    </div>
                </PopoverContent>
            </Popover>
        </div>
    );
}

function SelectField<TValue extends string>({
    label,
    value,
    onChange,
    options,
}: {
    label: string;
    value: TValue;
    onChange: (value: TValue) => void;
    options: Array<{ value: TValue; label: string }>;
}) {
    return (
        <div className="block">
            <span className="mb-1.5 block text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">{label}</span>
            <Select value={value} onValueChange={(nextValue) => onChange(nextValue as TValue)}>
                <SelectTrigger className="border-white/10 bg-black/20 font-mono text-xs text-gray-200 hover:border-white/20 focus:border-amber-500/40">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#09090d] font-mono text-xs text-gray-200">
                    {options.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="font-mono text-xs text-gray-200">
                            {option.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

function getMultiSelectLabel({ selectedValues, emptyLabel }: { selectedValues: string[]; emptyLabel: string }) {
    if (selectedValues.length === 0) {
        return emptyLabel;
    }

    if (selectedValues.length <= 2) {
        return selectedValues.join(", ");
    }

    return `${selectedValues[0]}, ${selectedValues[1]} +${selectedValues.length - 2}`;
}
