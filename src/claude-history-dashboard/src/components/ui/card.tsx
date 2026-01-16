import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Renders a styled card container and forwards props to the root div.
 *
 * Accepts standard div props. Merges the provided `className` with the component's default card classes and applies `data-slot="card"`.
 *
 * @param props - Standard div props; `className` is combined with the component's default styling.
 * @returns The root div element representing the card container.
 */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders the header area of a Card with structured layout and a `data-slot="card-header"` attribute for composition.
 *
 * @param className - Additional CSS classes to merge with the component's default header classes
 * @returns A `div` element used as the card header with layout and spacing classes applied
 */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders a card title container with title typography and a `data-slot="card-title"` marker.
 *
 * @param className - Additional class names to merge with the default title styles
 * @returns The rendered div element used as the card title
 */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

/**
 * Renders a card description container with muted, small text styling.
 *
 * Additional `className` values are merged with the component's base classes and
 * all other props are forwarded to the underlying `div`.
 *
 * @param className - Additional class names to merge with the default styling
 * @returns The rendered `div` element for the card description
 */
function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

/**
 * Renders a div that serves as the Card's action area, positioned to the top-right of the header.
 *
 * @param className - Additional class names to merge with the component's default layout classes
 * @returns A `JSX.Element` representing the action container for a Card
 */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

/**
 * Card content container that applies horizontal padding and merges any provided classes.
 *
 * @param className - Additional CSS classes to merge with the component's base padding class
 * @returns A div element with `data-slot="card-content"` and the combined classes
 */
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

/**
 * Renders the footer slot for a Card component.
 *
 * The element receives layout and spacing classes (flex alignment, horizontal padding, and top padding when a border is present), merges any provided `className`, and forwards remaining props to the underlying div.
 *
 * @returns The rendered footer div element with `data-slot="card-footer"` and composed classes.
 */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}