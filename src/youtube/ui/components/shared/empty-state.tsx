import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent } from "@app/utils/ui/components/card";
import { SearchX } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({ title, body, cta }: { title: string; body: string; cta?: ReactNode }) {
    return (
        <Card className="yt-panel overflow-hidden border-dashed">
            <CardContent className="grid min-h-80 place-items-center p-10 text-center">
                <div className="mx-auto max-w-md space-y-4">
                    <div className="mx-auto grid size-16 place-items-center rounded-2xl border border-secondary/30 bg-secondary/10 text-secondary">
                        <SearchX className="size-7" />
                    </div>
                    <div>
                        <h3 className="text-2xl font-semibold">{title}</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
                    </div>
                    {cta ? <div className="pt-2">{cta}</div> : <Button variant="outline">Refresh</Button>}
                </div>
            </CardContent>
        </Card>
    );
}
