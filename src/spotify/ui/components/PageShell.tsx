/**
 * Page chrome: the title block every route opens with, and the loading / error / empty
 * states that would otherwise be re-invented on each of them.
 */
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Card } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { IconContainer } from "@ui/custom/icon-container";
import { SectionLabel } from "@ui/custom/section-label";
import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({
    title,
    subtitle,
    icon,
    actions,
}: {
    title: string;
    subtitle?: string;
    icon?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
            <div className="flex items-center gap-3">
                {icon && <IconContainer variant="cyan" icon={icon} />}
                <div>
                    <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
                    {subtitle && <p className="text-xs text-muted-foreground mt-0.5 font-mono">{subtitle}</p>}
                </div>
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
    );
}

export function Section({
    title,
    hint,
    actions,
    children,
}: {
    title: string;
    hint?: string;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="mb-8">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                    <SectionLabel>{title}</SectionLabel>
                    {hint && <p className="text-xs text-muted-foreground mt-1 max-w-3xl">{hint}</p>}
                </div>
                {actions}
            </div>
            {children}
        </section>
    );
}

/** One headline number with a caption, used in every page's stat strip. */
export function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
    return (
        <Card variant="wow-static" className="p-3">
            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">{label}</div>
            <div className="text-lg font-semibold text-foreground">{value}</div>
            {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </Card>
    );
}

export function LoadingBlock({ rows = 6 }: { rows?: number }) {
    return (
        <div className="space-y-2">
            {Array.from({ length: rows }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
            ))}
        </div>
    );
}

export function ErrorBlock({ error }: { error: Error }) {
    return (
        <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not load this report</AlertTitle>
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{error.message}</AlertDescription>
        </Alert>
    );
}

export function EmptyBlock({ title, description }: { title: string; description?: string }) {
    return (
        <Card variant="wow-static" className="p-8 text-center">
            <div className="flex justify-center mb-3">
                <IconContainer variant="cyan" icon={<Inbox className="h-5 w-5" />} />
            </div>
            <div className="text-sm font-medium text-foreground">{title}</div>
            {description && <div className="text-xs text-muted-foreground mt-1">{description}</div>}
        </Card>
    );
}

/** Renders the first state that applies: loading, error, empty, then the data. */
export function ReportState<T>({
    query,
    isEmpty,
    emptyTitle = "Nothing in this window",
    emptyDescription = "Widen the date range in the header, or pick another profile.",
    children,
    rows,
}: {
    query: { isPending: boolean; error: Error | null; data: T | undefined };
    isEmpty?: (data: T) => boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    rows?: number;
    children: (data: T) => ReactNode;
}) {
    if (query.isPending) {
        return <LoadingBlock rows={rows} />;
    }

    if (query.error) {
        return <ErrorBlock error={query.error} />;
    }

    if (!query.data) {
        return <EmptyBlock title={emptyTitle} description={emptyDescription} />;
    }

    if (isEmpty?.(query.data)) {
        return <EmptyBlock title={emptyTitle} description={emptyDescription} />;
    }

    return <>{children(query.data)}</>;
}
