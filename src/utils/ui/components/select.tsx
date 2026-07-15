import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@ui/lib/utils";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import * as React from "react";

// Portal container context: consumers rendering inside a shadow root (e.g. the
// YouTube extension) provide the shadow host here so Radix's popup portals
// inside the same DOM subtree, inheriting the shadow's scoped Tailwind CSS.
// Default null → Radix falls back to document.body (regular pages).
export const PortalContainerContext = React.createContext<HTMLElement | null>(null);

export function PortalContainerProvider({
    container,
    children,
}: {
    container: HTMLElement | null;
    children: React.ReactNode;
}) {
    return <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>;
}

// Per-select identity so the shadow-DOM outside-dismiss below can tell "my
// own trigger/content" apart from another select's in the composed path.
const ShadowSelectIdContext = React.createContext<string | null>(null);

function Select({ open: openProp, onOpenChange, ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
    const portalContainer = React.useContext(PortalContainerContext);
    const shadowSelectId = React.useId();
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
    const open = openProp ?? uncontrolledOpen;

    const handleOpenChange = React.useCallback(
        (next: boolean) => {
            setUncontrolledOpen(next);
            onOpenChange?.(next);
        },
        [onOpenChange]
    );

    // Radix's DismissableLayer reads `event.target`, which shadow DOM
    // retargets to the shadow HOST for document-level listeners — so inside a
    // shadow root, outside-pointerdown never dismisses an open select
    // (radix-ui/primitives lacks composedPath handling). When portaled into a
    // shadow root, run our own composedPath-based outside-dismiss.
    React.useEffect(() => {
        if (!portalContainer || !open) {
            return;
        }

        function onPointerDown(event: PointerEvent): void {
            const inside = event
                .composedPath()
                .some((node) => node instanceof HTMLElement && node.dataset.shadowSelect === shadowSelectId);

            if (!inside) {
                handleOpenChange(false);
            }
        }

        document.addEventListener("pointerdown", onPointerDown, { capture: true });
        return () => document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    }, [portalContainer, open, shadowSelectId, handleOpenChange]);

    return (
        <ShadowSelectIdContext.Provider value={shadowSelectId}>
            <SelectPrimitive.Root data-slot="select" open={open} onOpenChange={handleOpenChange} {...props} />
        </ShadowSelectIdContext.Provider>
    );
}

function SelectGroup(props: React.ComponentProps<typeof SelectPrimitive.Group>) {
    return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
    return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
    const shadowSelectId = React.useContext(ShadowSelectIdContext);

    return (
        <SelectPrimitive.Trigger
            data-slot="select-trigger"
            data-shadow-select={shadowSelectId ?? undefined}
            className={cn(
                "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground",
                className
            )}
            {...props}
        >
            {children}
            <SelectPrimitive.Icon asChild>
                <ChevronDownIcon className="size-4 opacity-60" />
            </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
    );
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
    return (
        <SelectPrimitive.ScrollUpButton
            data-slot="select-scroll-up-button"
            className={cn("flex cursor-default items-center justify-center py-1", className)}
            {...props}
        >
            <ChevronUpIcon className="size-4" />
        </SelectPrimitive.ScrollUpButton>
    );
}

function SelectScrollDownButton({
    className,
    ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
    return (
        <SelectPrimitive.ScrollDownButton
            data-slot="select-scroll-down-button"
            className={cn("flex cursor-default items-center justify-center py-1", className)}
            {...props}
        >
            <ChevronDownIcon className="size-4" />
        </SelectPrimitive.ScrollDownButton>
    );
}

function SelectContent({
    className,
    children,
    position = "popper",
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
    const portalContainer = React.useContext(PortalContainerContext);
    const shadowSelectId = React.useContext(ShadowSelectIdContext);
    return (
        <SelectPrimitive.Portal container={portalContainer ?? undefined}>
            <SelectPrimitive.Content
                data-slot="select-content"
                data-shadow-select={shadowSelectId ?? undefined}
                className={cn(
                    // Solid popover — explicit hsl fallback via arbitrary value so
                    // consumers embedded in shadow DOMs (e.g. YT extension) never
                    // end up transparent when tailwind's theme var doesn't cascade.
                    "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border border-border shadow-lg bg-popover text-popover-foreground",
                    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
                    position === "popper" &&
                        "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
                    className
                )}
                position={position}
                {...props}
            >
                <SelectScrollUpButton />
                <SelectPrimitive.Viewport
                    className={cn(
                        "p-1",
                        position === "popper" &&
                            "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]"
                    )}
                >
                    {children}
                </SelectPrimitive.Viewport>
                <SelectScrollDownButton />
            </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
    );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
    return (
        <SelectPrimitive.Label
            data-slot="select-label"
            className={cn("px-2 py-1.5 text-xs font-semibold text-muted-foreground", className)}
            {...props}
        />
    );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
    return (
        <SelectPrimitive.Item
            data-slot="select-item"
            className={cn(
                "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                className
            )}
            {...props}
        >
            <span className="absolute right-2 flex size-3.5 items-center justify-center">
                <SelectPrimitive.ItemIndicator>
                    <CheckIcon className="size-4" />
                </SelectPrimitive.ItemIndicator>
            </span>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </SelectPrimitive.Item>
    );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
    return (
        <SelectPrimitive.Separator
            data-slot="select-separator"
            className={cn("bg-border -mx-1 my-1 h-px", className)}
            {...props}
        />
    );
}

export {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectScrollDownButton,
    SelectScrollUpButton,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
};
