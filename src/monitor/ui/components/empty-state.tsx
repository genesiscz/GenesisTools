import { Card, CardContent } from "@genesiscz/utils/ui/components/card";
import { Radar } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
    title,
    body,
    cta,
    icon: Icon = Radar,
}: {
    title: string;
    body: string;
    cta?: ReactNode;
    icon?: typeof Radar;
}) {
    return (
        <Card className="mon-panel overflow-hidden border-dashed">
            <CardContent className="grid min-h-80 place-items-center p-10 text-center">
                <div className="mx-auto max-w-md space-y-4">
                    <div className="mx-auto grid size-16 place-items-center rounded-2xl border border-secondary/30 bg-secondary/10 text-secondary shadow-[0_0_30px_rgba(6,182,212,0.15)]">
                        <Icon className="size-7" />
                    </div>
                    <div>
                        <h3 className="text-2xl font-semibold">{title}</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
                    </div>
                    {cta ? <div className="pt-2">{cta}</div> : null}
                </div>
            </CardContent>
        </Card>
    );
}
