"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@ui/components/dialog";
import { cn } from "@ui/lib/utils";
import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronDown, Loader2, MapPin, SearchIcon } from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
    return (
        <CommandPrimitive
            data-slot="command"
            className={cn(
                "bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md",
                className
            )}
            {...props}
        />
    );
}

function CommandDialog({
    title = "Command Palette",
    description = "Search for a command to run...",
    children,
    className,
    showCloseButton = true,
    ...props
}: React.ComponentProps<typeof Dialog> & {
    title?: string;
    description?: string;
    className?: string;
    showCloseButton?: boolean;
}) {
    return (
        <Dialog {...props}>
            <DialogContent className={cn("overflow-hidden p-0", className)} showCloseButton={showCloseButton}>
                <DialogHeader className="sr-only">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <Command className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[data-slot=command-input-wrapper]]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
                    {children}
                </Command>
            </DialogContent>
        </Dialog>
    );
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
    return (
        <div data-slot="command-input-wrapper" className="flex h-9 items-center gap-2 border-b px-3">
            <SearchIcon className="size-4 shrink-0 opacity-50" />
            <CommandPrimitive.Input
                data-slot="command-input"
                className={cn(
                    "placeholder:text-muted-foreground flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
                    className
                )}
                {...props}
            />
        </div>
    );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
    return (
        <CommandPrimitive.List
            data-slot="command-list"
            className={cn("max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto", className)}
            {...props}
        />
    );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
    return <CommandPrimitive.Empty data-slot="command-empty" className="py-6 text-center text-sm" {...props} />;
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
    return (
        <CommandPrimitive.Group
            data-slot="command-group"
            className={cn(
                "text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium",
                className
            )}
            {...props}
        />
    );
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
    return (
        <CommandPrimitive.Separator
            data-slot="command-separator"
            className={cn("bg-border -mx-1 h-px", className)}
            {...props}
        />
    );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
    return (
        <CommandPrimitive.Item
            data-slot="command-item"
            className={cn(
                "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className
            )}
            {...props}
        />
    );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
    return (
        <span
            data-slot="command-shortcut"
            className={cn("text-muted-foreground ml-auto text-xs tracking-widest", className)}
            {...props}
        />
    );
}

interface BaseDistrictCommandSelectProps {
    className?: string;
    shouldFilter?: boolean;
    loadingDelay?: number;
    onOpenChange?: (open: boolean) => void;
    placeholder?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    error?: boolean;
    disabled?: boolean;
}

interface SingleDistrictCommandSelectProps extends BaseDistrictCommandSelectProps {
    mode?: "single";
    value: string;
    onValueChange: (value: string) => void;
    onSelect?: (value: string) => void;
    selected?: never;
    onToggle?: never;
}

interface MultiDistrictCommandSelectProps extends BaseDistrictCommandSelectProps {
    mode: "multi";
    selected: string[];
    onValueChange: (value: string[]) => void;
    onSelect?: (value: string) => void;
    maxSelections?: number;
    onToggle?: (district: string) => void;
    value?: never;
}

type DistrictCommandSelectProps = SingleDistrictCommandSelectProps | MultiDistrictCommandSelectProps;

interface DistrictListResponse {
    districts: string[];
    praha: string[];
}

interface SearchDistrictResult {
    name: string;
    reasId: string;
}

interface SearchDistrictsResponse {
    districts: SearchDistrictResult[];
}

type DistrictsApiResponse = DistrictListResponse | SearchDistrictsResponse;

function isSearchResponse(response: DistrictsApiResponse): response is SearchDistrictsResponse {
    return response.districts.length > 0 && typeof response.districts[0] === "object";
}

function normalizeDistricts(response: DistrictsApiResponse): DistrictListResponse {
    if (isSearchResponse(response)) {
        return {
            districts: response.districts.map((district) => district.name),
            praha: [],
        };
    }

    return {
        districts: response.districts,
        praha: response.praha,
    };
}

function DistrictCommandSelect(props: DistrictCommandSelectProps) {
    const {
        shouldFilter = true,
        loadingDelay = 500,
        onOpenChange,
        placeholder,
        searchPlaceholder = "Search districts...",
        emptyText = "No districts found",
        error,
        disabled,
        className,
    } = props;
    const isMulti = props.mode === "multi";
    const multiProps = props.mode === "multi" ? props : null;

    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [filterQuery, setFilterQuery] = useState("");
    const [districts, setDistricts] = useState<string[]>([]);
    const [prahaDistricts, setPrahaDistricts] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [showLoading, setShowLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);

    const prahaSet = useMemo(() => new Set(prahaDistricts), [prahaDistricts]);

    const normalizedSearch = search.trim().toLowerCase();

    useEffect(() => {
        const timer = globalThis.setTimeout(() => {
            setFilterQuery(normalizedSearch);
        }, 180);

        return () => {
            clearTimeout(timer);
        };
    }, [normalizedSearch]);

    useEffect(() => {
        if (!open) {
            return;
        }

        const controller = new AbortController();
        let active = true;
        const loadingTimer = globalThis.setTimeout(() => {
            if (active) {
                setShowLoading(true);
            }
        }, loadingDelay);

        const loadDistricts = async () => {
            const params = new URLSearchParams();

            if (filterQuery) {
                params.set("q", filterQuery);
            }

            setLoading(true);
            setShowLoading(false);
            setErrorMessage("");

            try {
                const response = await fetch(`/api/districts?${params.toString()}`, {
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch districts (${response.status})`);
                }

                const payload = (await response.json()) as DistrictsApiResponse;
                const normalized = normalizeDistricts(payload);
                const sortedDistricts = [...normalized.districts].sort((a, b) => a.localeCompare(b));
                const sortedPraha = [...normalized.praha].sort((a, b) => a.localeCompare(b));

                if (active) {
                    setDistricts(sortedDistricts);
                    setPrahaDistricts(sortedPraha);
                }
            } catch (err) {
                if (err instanceof Error && err.name === "AbortError") {
                    return;
                }

                const message = err instanceof Error ? err.message : "Failed to load districts";

                if (active) {
                    setDistricts([]);
                    setPrahaDistricts([]);
                    setErrorMessage(message);
                }
            } finally {
                if (active) {
                    setLoading(false);
                    setShowLoading(false);
                }
                clearTimeout(loadingTimer);
            }
        };

        void loadDistricts();

        return () => {
            active = false;
            controller.abort();
            clearTimeout(loadingTimer);
        };
    }, [open, filterQuery, loadingDelay]);

    const visiblePraha = useMemo(() => {
        if (!shouldFilter) {
            return prahaDistricts;
        }

        if (!normalizedSearch) {
            return prahaDistricts;
        }

        return prahaDistricts.filter((district) => district.toLowerCase().includes(normalizedSearch));
    }, [normalizedSearch, prahaDistricts, shouldFilter]);

    const visibleOther = useMemo(() => {
        const others = districts.filter((district) => !prahaSet.has(district));

        if (!shouldFilter) {
            return others;
        }

        if (!normalizedSearch) {
            return others;
        }

        return others.filter((district) => district.toLowerCase().includes(normalizedSearch));
    }, [districts, normalizedSearch, shouldFilter, prahaSet]);

    const hasAnyDistrict = visiblePraha.length > 0 || visibleOther.length > 0;
    const singleValue = props.mode === "multi" ? "" : props.value;
    const multiValue = multiProps?.selected ?? [];
    const maxSelections = multiProps?.maxSelections;

    const buttonLabel = useMemo(() => {
        if (isMulti) {
            if (multiValue.length === 0) {
                return placeholder || "Select districts...";
            }

            if (multiValue.length === 1) {
                return multiValue[0];
            }

            if (maxSelections && multiValue.length >= maxSelections) {
                return `${multiValue[0]} + ${multiValue.length - 1} selected (max ${maxSelections})`;
            }

            return `${multiValue[0]} + ${multiValue.length - 1} selected`;
        }

        return singleValue || placeholder || "Select district...";
    }, [isMulti, maxSelections, multiValue, placeholder, singleValue]);

    const setOpenWithNotify = useCallback(
        (next: boolean) => {
            setOpen(next);

            if (onOpenChange) {
                onOpenChange(next);
            }
        },
        [onOpenChange]
    );

    const selectDistrict = (district: string) => {
        if (props.mode === "multi") {
            const current = props.selected;
            const isSelected = current.includes(district);

            if (isSelected) {
                const nextValue = current.filter((name) => name !== district);
                props.onValueChange(nextValue);
                props.onSelect?.(district);
                return;
            }

            if (maxSelections && current.length >= maxSelections) {
                return;
            }

            const nextValue = [...current, district];
            props.onValueChange(nextValue);
            props.onSelect?.(district);
            props.onToggle?.(district);
            return;
        }

        props.onValueChange(district);
        props.onSelect?.(district);
        setOpenWithNotify(false);
        setSearch("");
    };

    const renderListItem = (district: string) => {
        const isSelected = isMulti ? multiValue.includes(district) : district === singleValue;
        const disabledItem =
            isMulti && !isSelected && maxSelections !== undefined && multiValue.length >= maxSelections;

        return (
            <CommandItem
                key={district}
                value={district}
                onSelect={() => selectDistrict(district)}
                disabled={disabledItem}
                className={cn(
                    "cursor-pointer font-mono text-xs",
                    "data-[selected=true]:bg-primary/10 data-[selected=true]:text-primary/80",
                    isSelected && "text-primary",
                    disabledItem && "text-gray-600 cursor-not-allowed"
                )}
            >
                <MapPin className="h-3 w-3 text-primary/60" />
                {district}
                {isSelected ? <Check className="ml-auto h-3.5 w-3 text-primary" /> : null}
            </CommandItem>
        );
    };

    useEffect(() => {
        if (!open) {
            return;
        }

        const onDocumentClick = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setOpenWithNotify(false);
            }
        };

        const onEsc = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpenWithNotify(false);
            }
        };

        document.addEventListener("mousedown", onDocumentClick);
        document.addEventListener("keydown", onEsc);

        return () => {
            document.removeEventListener("mousedown", onDocumentClick);
            document.removeEventListener("keydown", onEsc);
        };
    }, [open, setOpenWithNotify]);

    const dropdownContent = open ? (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-primary/20 bg-[rgba(10,10,20,0.98)] shadow-lg shadow-black/50 animate-slide-up">
            <Command className="bg-transparent" shouldFilter={shouldFilter}>
                <CommandInput
                    placeholder={isMulti ? "Filter districts..." : searchPlaceholder || "Search districts..."}
                    value={search}
                    onValueChange={setSearch}
                    className="font-mono text-xs"
                />

                <CommandList className="max-h-[260px]">
                    {errorMessage ? (
                        <div className="px-3 py-5 text-xs text-red-400 font-mono">{errorMessage}</div>
                    ) : showLoading && loading ? (
                        <div className="px-3 py-5 text-xs text-muted-foreground font-mono flex items-center gap-2">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading districts...
                        </div>
                    ) : hasAnyDistrict ? null : (
                        <CommandEmpty className="py-4 text-xs text-muted-foreground font-mono">
                            {search ? emptyText : "Type to search districts"}
                        </CommandEmpty>
                    )}

                    {isMulti ? (
                        <div>
                            {visiblePraha.length > 0 && (
                                <CommandGroup
                                    heading="Praha"
                                    className="[&_[cmdk-group-heading]]:text-cyan-400 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                                >
                                    {visiblePraha.map((district) => renderListItem(district))}
                                </CommandGroup>
                            )}

                            {visibleOther.length > 0 && (
                                <CommandGroup
                                    heading="Districts"
                                    className="[&_[cmdk-group-heading]]:text-primary [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                                >
                                    {visibleOther.map((district) => renderListItem(district))}
                                </CommandGroup>
                            )}
                        </div>
                    ) : (
                        <div>
                            {visiblePraha.length > 0 && (
                                <CommandGroup
                                    heading="Praha"
                                    className="[&_[cmdk-group-heading]]:text-cyan-400 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                                >
                                    {visiblePraha.map((district) => renderListItem(district))}
                                </CommandGroup>
                            )}

                            {visibleOther.length > 0 && (
                                <CommandGroup
                                    heading="Districts"
                                    className="[&_[cmdk-group-heading]]:text-primary [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                                >
                                    {visibleOther.map((district) => renderListItem(district))}
                                </CommandGroup>
                            )}
                        </div>
                    )}
                </CommandList>
            </Command>
        </div>
    ) : null;

    return (
        <div ref={containerRef} className={cn("relative", className)}>
            <button
                type="button"
                onClick={() => {
                    if (disabled) {
                        return;
                    }

                    setOpenWithNotify(!open);
                }}
                className={cn(
                    "flex h-9 w-full items-center justify-between rounded-md border px-3 py-1 text-sm transition-all",
                    "glass-card bg-transparent font-mono text-left",
                    error
                        ? "border-red-500/50 ring-2 ring-red-500/20"
                        : "border-primary/30 focus:border-primary/50 focus:ring-2 focus:ring-primary/30",
                    open ? "ring-2 ring-primary/30" : null
                )}
            >
                <span className="flex items-center gap-2 truncate">
                    <MapPin className="h-3.5 w-3 shrink-0 text-primary" />
                    {buttonLabel}
                </span>
                <ChevronDown className={cn("h-4 w-4 shrink-0 opacity-60 transition-transform", open && "rotate-180")} />
            </button>

            {dropdownContent}
        </div>
    );
}

export {
    Command,
    CommandDialog,
    CommandInput,
    CommandList,
    CommandEmpty,
    CommandGroup,
    CommandItem,
    CommandShortcut,
    CommandSeparator,
    DistrictCommandSelect,
};
