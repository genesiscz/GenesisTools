import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import type * as React from "react";
import { ResponsiveContainer } from "recharts";

interface ChartContainerProps extends Omit<React.ComponentProps<typeof Card>, "title" | "children"> {
    title?: React.ReactNode;
    description?: React.ReactNode;
    height?: number;
    contentClassName?: string;
    children: React.ReactElement;
}

function ChartContainer({
    className,
    title,
    description,
    height = 320,
    contentClassName,
    children,
    ...props
}: ChartContainerProps) {
    return (
        <Card className={cn("min-w-0 overflow-hidden", className)} {...props}>
            {(title || description) && (
                <CardHeader className="gap-1">
                    {title ? <CardTitle>{title}</CardTitle> : null}
                    {description ? <CardDescription>{description}</CardDescription> : null}
                </CardHeader>
            )}
            <CardContent className={cn("min-w-0 pt-0", contentClassName)}>
                <div className="min-w-0 w-full overflow-hidden" style={{ height }}>
                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={height}>
                        {children}
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}

export { ChartContainer };
