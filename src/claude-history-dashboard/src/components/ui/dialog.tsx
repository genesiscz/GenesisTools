import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Renders a Radix Dialog root element with a `data-slot="dialog"` attribute and forwards all received props.
 *
 * @returns The Dialog root JSX element with forwarded props applied.
 */
function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

/**
 * Renders a dialog trigger element with a `data-slot="dialog-trigger"` attribute.
 *
 * @returns The Dialog trigger element with all props forwarded to the underlying trigger primitive.
 */
function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

/**
 * Renders a Radix Dialog Portal with a data-slot set to "dialog-portal".
 *
 * @param props - Props to pass through to the underlying DialogPrimitive.Portal; all props are forwarded.
 * @returns A DialogPrimitive.Portal element with `data-slot="dialog-portal"` that receives the provided props.
 */
function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

/**
 * Renders a Dialog close trigger element with a data-slot attribute for styling and testing.
 *
 * @returns A Dialog close trigger element with `data-slot="dialog-close"` and all provided props forwarded.
 */
function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/**
 * Render a styled dialog overlay element.
 *
 * Applies the component's backdrop styling and state-based animation classes, exposes a data-slot for styling/testing, and forwards all other overlay props.
 *
 * @param className - Additional class names to append to the overlay's default classes
 * @returns The dialog overlay element with a composed className and `data-slot="dialog-overlay"`
 */
function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

/**
 * Render dialog content inside a portal with an overlay and an optional close control.
 *
 * Renders a positioned dialog content element centered in the viewport, wrapped by a portal and overlay. When `showCloseButton` is true, a positioned close button is rendered inside the content.
 *
 * @param showCloseButton - Whether to render the internal close button (default: `true`)
 * @returns The rendered dialog content element
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 outline-none sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

/**
 * Renders the dialog header container with default layout classes and a `data-slot` for styling/hooks.
 *
 * Forwards remaining props to the underlying `div`.
 */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

/**
 * Renders a dialog footer container with a data-slot and responsive layout.
 *
 * Merges the provided `className` with default classes that stack children vertically on small
 * screens and align them to the end on larger screens. Forwards all other props to the underlying `div`.
 *
 * @returns A `div` element serving as the dialog footer with applied classes and forwarded props.
 */
function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders a dialog title element with a consistent data-slot and default typography.
 *
 * @returns A DialogPrimitive.Title element with `data-slot="dialog-title"` and composed typography classes.
 */
function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

/**
 * Renders a dialog description element with a standardized data-slot and typography.
 *
 * @returns A `DialogPrimitive.Description` element with `data-slot="dialog-description"` and merged `text-muted-foreground text-sm` plus any provided `className`.
 */
function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}