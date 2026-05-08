import {
    Pagination,
    PaginationContent,
    PaginationItem,
    PaginationNext,
    PaginationPrevious,
} from "@app/utils/ui/components/pagination";
import { Skeleton } from "@app/utils/ui/components/skeleton";
import type { MasterListResponse } from "@app/shops/types";
import { LayoutGrid } from "lucide-react";
import { BrowseCard } from "./BrowseCard";
import { EmptyState } from "./EmptyState";

interface BrowseGridProps {
    data: MasterListResponse | undefined;
    isLoading: boolean;
    page: number;
    onPageChange: (page: number) => void;
}

const PAGE_SIZE = 50;

export function BrowseGrid({ data, isLoading, page, onPageChange }: BrowseGridProps) {
    if (isLoading) {
        return (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
                {Array.from({ length: 12 }, (_, i) => (
                    <Skeleton key={i} className="aspect-[3/4] rounded" />
                ))}
            </div>
        );
    }

    if (!data || data.items.length === 0) {
        return (
            <EmptyState
                icon={<LayoutGrid />}
                title="NO MASTERS"
                body="No products match the current filters. Try clearing brand/category or running a crawl: tools shops crawl --shop rohlik."
            />
        );
    }

    const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
                {data.items.map((item) => (
                    <BrowseCard key={item.id} item={item} />
                ))}
            </div>
            {totalPages > 1 && (
                <Pagination>
                    <PaginationContent className="font-mono text-xs">
                        <PaginationItem>
                            <PaginationPrevious
                                onClick={(e) => {
                                    e.preventDefault();
                                    if (page > 1) {
                                        onPageChange(page - 1);
                                    }
                                }}
                                aria-disabled={page === 1}
                                className={page === 1 ? "pointer-events-none opacity-40" : ""}
                            />
                        </PaginationItem>
                        <PaginationItem>
                            <span className="px-3 font-mono text-xs text-muted-foreground">
                                {page} / {totalPages}
                            </span>
                        </PaginationItem>
                        <PaginationItem>
                            <PaginationNext
                                onClick={(e) => {
                                    e.preventDefault();
                                    if (page < totalPages) {
                                        onPageChange(page + 1);
                                    }
                                }}
                                aria-disabled={page === totalPages}
                                className={page === totalPages ? "pointer-events-none opacity-40" : ""}
                            />
                        </PaginationItem>
                    </PaginationContent>
                </Pagination>
            )}
        </div>
    );
}
