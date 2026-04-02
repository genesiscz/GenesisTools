import { Button, buttonVariants } from "@ui/components/button";
import { cn } from "@ui/lib/utils";
import type { VariantProps } from "class-variance-authority";
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import type * as React from "react";

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
    return <nav aria-label="pagination" className={cn("mx-auto flex w-full justify-center", className)} {...props} />;
}

function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
    return <ul className={cn("flex flex-row items-center gap-2", className)} {...props} />;
}

function PaginationItem(props: React.ComponentProps<"li">) {
    return <li {...props} />;
}

type PaginationLinkProps = React.ComponentProps<"a"> & {
    isActive?: boolean;
} & Pick<VariantProps<typeof buttonVariants>, "size">;

function PaginationLink({ className, isActive, size = "icon", ...props }: PaginationLinkProps) {
    return (
        <a
            aria-current={isActive ? "page" : undefined}
            className={cn(buttonVariants({ variant: isActive ? "secondary" : "ghost", size }), "min-w-9", className)}
            {...props}
        />
    );
}

function PaginationPrevious({ className, ...props }: React.ComponentProps<typeof PaginationLink>) {
    return (
        <PaginationLink
            aria-label="Go to previous page"
            size="default"
            className={cn("gap-1 px-2.5 sm:pl-2.5", className)}
            {...props}
        >
            <ChevronLeftIcon className="size-4" />
            <span>Previous</span>
        </PaginationLink>
    );
}

function PaginationNext({ className, ...props }: React.ComponentProps<typeof PaginationLink>) {
    return (
        <PaginationLink
            aria-label="Go to next page"
            size="default"
            className={cn("gap-1 px-2.5 sm:pr-2.5", className)}
            {...props}
        >
            <span>Next</span>
            <ChevronRightIcon className="size-4" />
        </PaginationLink>
    );
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
    return (
        <span aria-hidden className={cn("flex size-9 items-center justify-center", className)} {...props}>
            <MoreHorizontalIcon className="size-4" />
            <span className="sr-only">More pages</span>
        </span>
    );
}

function PaginationButton(props: React.ComponentProps<typeof Button>) {
    return <Button variant="ghost" size="icon" {...props} />;
}

export {
    Pagination,
    PaginationButton,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
};
