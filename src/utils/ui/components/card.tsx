import { cn } from "@ui/lib/utils";
import type * as React from "react";

type CardVariant = "default" | "wow" | "wow-static" | "cyber" | "plain";

export type CardAccent = "violet" | "purple" | "orange" | "emerald" | "blue" | "cyan" | "red" | "pink" | "amber";

interface CardProps extends React.ComponentProps<"div"> {
    variant?: CardVariant;
    /**
     * Tints the card's static border, hover glow ring, and box-shadow with the
     * chosen color. Works on `wow` and `wow-static` variants. No-op on
     * `default`, `cyber`, and `plain`.
     */
    accent?: CardAccent;
}

const cardVariants: Record<CardVariant, string> = {
    // Default: theme-aware — CSS in wow-components.css picks the look based
    // on parent className (.wow / .cyberpunk / neither).
    default: "text-card-foreground",
    // Explicit wow glow with hover border ring
    wow: "wow-glow-hover text-card-foreground",
    // Wow gradient bg without hover effects (for metric / stat cards)
    "wow-static": "wow-glow text-card-foreground",
    // Cyberpunk neon look
    cyber: "glass-card neon-border bg-transparent text-card-foreground",
    // Flat, no hover effects
    plain: "bg-card text-card-foreground border shadow-sm",
};

function Card({ className, variant = "default", accent, ...props }: CardProps) {
    return (
        <div
            data-slot="card"
            data-variant={variant}
            data-accent={accent}
            className={cn("flex flex-col gap-6 rounded-xl py-6", cardVariants[variant], className)}
            {...props}
        />
    );
}

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
    );
}

interface CardTitleProps extends React.ComponentProps<"div"> {
    gradient?: boolean;
}

function CardTitle({ className, gradient = false, ...props }: CardTitleProps) {
    return (
        <div
            data-slot="card-title"
            className={cn("leading-none font-semibold", gradient && "gradient-text", className)}
            {...props}
        />
    );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="card-description" className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-action"
            className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
            {...props}
        />
    );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
    return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div data-slot="card-footer" className={cn("flex items-center px-6 [.border-t]:pt-6", className)} {...props} />
    );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
