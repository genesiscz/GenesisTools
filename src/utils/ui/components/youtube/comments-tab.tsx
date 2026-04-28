import { Badge } from "@app/utils/ui/components/badge";
import { MessageCircle } from "lucide-react";

export function CommentsTab() {
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">Top Comments</p>
                    <h3 className="mt-2 text-2xl font-bold">Audience signal</h3>
                </div>
                <Badge>Coming in v1.1</Badge>
            </div>
            <div className="grid gap-3">
                {Array.from({ length: 3 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-dashed border-primary/20 bg-black/20 p-4 opacity-70"
                    >
                        <div className="mb-3 flex items-center gap-3">
                            <div className="grid size-10 place-items-center rounded-full bg-secondary/10 text-secondary">
                                <MessageCircle className="size-4" />
                            </div>
                            <div className="space-y-2">
                                <div className="h-3 w-32 rounded bg-muted" />
                                <div className="h-2 w-20 rounded bg-muted/60" />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <div className="h-2 rounded bg-muted/70" />
                            <div className="h-2 w-2/3 rounded bg-muted/50" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
