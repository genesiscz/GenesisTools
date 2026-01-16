"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Renders a table inside a horizontally scrollable container.
 *
 * @param className - Additional CSS classes to apply to the underlying `table` element
 * @param props - Other props forwarded to the underlying `table` element
 * @returns A React element containing a `table` wrapped in a container that enables horizontal scrolling
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

/**
 * Renders a table header element with a default row-bottom-border styling and a `data-slot="table-header"` marker.
 *
 * @returns The `<thead>` element with the default class `[&_tr]:border-b` merged with `className`
 */
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

/**
 * Renders a `tbody` element used as the table body with default styling and a data-slot for composition.
 *
 * Applies a default class that removes the bottom border on the last row and merges any provided `className`.
 *
 * @returns The rendered `tbody` element for table content.
 */
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

/**
 * Renders a table footer element with a data-slot and default muted styling.
 *
 * @returns A `tfoot` element with `data-slot="table-footer"` and combined class names.
 */
function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/50 border-t font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders a styled table row element for composing table layouts.
 *
 * @param className - Additional CSS classes to merge with the component's default styles
 * @param props - Remaining props forwarded to the underlying `tr` element
 * @returns The `tr` element with `data-slot="table-row"` and merged classes for hover, selected, border, and transition styling
 */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders a table header cell with consistent semantic styling and a `data-slot` attribute for composition.
 *
 * @param className - Additional CSS classes to apply to the element
 * @returns A `<th>` element with default header styles and the `data-slot="table-head"` attribute
 */
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders a table cell element with consistent padding, vertical alignment, and checkbox-aware spacing.
 *
 * @param className - Additional class names appended to the component's default styling
 * @returns A `td` element styled for table content; adjusts spacing when it contains a checkbox
 */
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

/**
 * Renders a table caption element with muted, compact styling.
 *
 * Forwards all props to the underlying `caption` element and merges the provided
 * `className` with default caption styles.
 *
 * @returns The `caption` element with muted foreground color, top margin, and small text size.
 */
function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}