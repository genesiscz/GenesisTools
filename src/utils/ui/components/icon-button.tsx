import { Button } from "@ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import { cn } from "@ui/lib/utils";
import type * as React from "react";
import { cloneElement, createContext, isValidElement, useContext } from "react";

/** Radix tooltip delay for icon-only controls (hover shows immediately). */
export const ICON_TOOLTIP_DELAY_MS = 0;

const IconTooltipScope = createContext(false);

/** Wrap app or dashboard shell so IconButton/IconTooltip skip per-control TooltipProvider. */
function IconTooltipProvider({ children }: { children: React.ReactNode }) {
    return (
        <IconTooltipScope.Provider value={true}>
            <TooltipProvider delayDuration={ICON_TOOLTIP_DELAY_MS} skipDelayDuration={ICON_TOOLTIP_DELAY_MS}>
                {children}
            </TooltipProvider>
        </IconTooltipScope.Provider>
    );
}

type TooltipContentSide = React.ComponentProps<typeof TooltipContent>["side"];
type TooltipContentAlign = React.ComponentProps<typeof TooltipContent>["align"];

type InstantTooltipProps = {
    tooltip: string;
    tooltipSide?: TooltipContentSide;
    tooltipAlign?: TooltipContentAlign;
    children: React.ReactElement;
};

function InstantTooltip({ tooltip, tooltipSide, tooltipAlign, children }: InstantTooltipProps) {
    const inScope = useContext(IconTooltipScope);
    const trigger = isValidElement(children)
        ? cloneElement(children, {
              "aria-label": tooltip,
          } as Record<string, unknown>)
        : children;

    const tree = (
        <Tooltip delayDuration={ICON_TOOLTIP_DELAY_MS}>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent side={tooltipSide} align={tooltipAlign}>
                {tooltip}
            </TooltipContent>
        </Tooltip>
    );

    if (inScope) {
        return tree;
    }

    return (
        <TooltipProvider delayDuration={ICON_TOOLTIP_DELAY_MS} skipDelayDuration={ICON_TOOLTIP_DELAY_MS}>
            {tree}
        </TooltipProvider>
    );
}

const iconButtonToneClass = {
    default: "",
    muted: "text-muted-foreground hover:text-foreground",
} as const;

/** shadcn `Button` with `size="icon"` plus required instant tooltip. */
type IconButtonProps = Omit<React.ComponentProps<typeof Button>, "aria-label" | "title"> & {
    tooltip: string;
    tooltipSide?: TooltipContentSide;
    tooltipAlign?: TooltipContentAlign;
    tone?: keyof typeof iconButtonToneClass;
};

function IconButton({
    tooltip,
    tooltipSide,
    tooltipAlign,
    tone = "default",
    className,
    children,
    size = "icon",
    variant = "ghost",
    ...props
}: IconButtonProps) {
    return (
        <InstantTooltip tooltip={tooltip} tooltipSide={tooltipSide} tooltipAlign={tooltipAlign}>
            <Button className={cn(iconButtonToneClass[tone], className)} size={size} variant={variant} {...props}>
                {children}
            </Button>
        </InstantTooltip>
    );
}

type IconTooltipProps = InstantTooltipProps;

/** Instant tooltip around any single trigger (Link, shell icon, PopoverTrigger child, …). */
function IconTooltip({ tooltip, children, tooltipSide, tooltipAlign }: IconTooltipProps) {
    return (
        <InstantTooltip tooltip={tooltip} tooltipSide={tooltipSide} tooltipAlign={tooltipAlign}>
            {children}
        </InstantTooltip>
    );
}

type IconPopoverProps = {
    tooltip: string;
    trigger: React.ReactElement;
    children: React.ReactNode;
    align?: React.ComponentProps<typeof PopoverContent>["align"];
    side?: React.ComponentProps<typeof PopoverContent>["side"];
    contentClassName?: string;
    tooltipSide?: TooltipContentSide;
    tooltipAlign?: TooltipContentAlign;
};

/** Popover with icon trigger + instant tooltip (no manual Tooltip/Popover nesting). */
function IconPopover({
    tooltip,
    trigger,
    children,
    align = "end",
    side,
    contentClassName,
    tooltipSide,
    tooltipAlign,
}: IconPopoverProps) {
    return (
        <Popover>
            <InstantTooltip tooltip={tooltip} tooltipSide={tooltipSide} tooltipAlign={tooltipAlign}>
                <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            </InstantTooltip>
            <PopoverContent align={align} side={side} className={contentClassName}>
                {children}
            </PopoverContent>
        </Popover>
    );
}

type IconDropdownMenuProps = {
    tooltip: string;
    trigger: React.ReactElement;
    children: React.ReactNode;
    align?: React.ComponentProps<typeof DropdownMenuContent>["align"];
    tooltipSide?: TooltipContentSide;
    tooltipAlign?: TooltipContentAlign;
};

/** Dropdown menu with icon trigger + instant tooltip. */
function IconDropdownMenu({
    tooltip,
    trigger,
    children,
    align = "end",
    tooltipSide,
    tooltipAlign,
}: IconDropdownMenuProps) {
    return (
        <DropdownMenu>
            <InstantTooltip tooltip={tooltip} tooltipSide={tooltipSide} tooltipAlign={tooltipAlign}>
                <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            </InstantTooltip>
            <DropdownMenuContent align={align}>{children}</DropdownMenuContent>
        </DropdownMenu>
    );
}

export { IconButton, IconDropdownMenu, IconPopover, IconTooltip, IconTooltipProvider };
