import { Input } from "@app/utils/ui/components/input";
import { Switch } from "@app/utils/ui/components/switch";

export interface VideoListFilterState {
    since: string;
    limit: number;
    includeShorts: boolean;
}

export function VideoListFilters({
    value,
    onChange,
}: {
    value: VideoListFilterState;
    onChange: (value: VideoListFilterState) => void;
}) {
    return (
        <div className="grid gap-3 rounded-2xl border border-primary/20 bg-black/20 p-4 md:grid-cols-[1fr_10rem_auto] md:items-end">
            <label className="space-y-2">
                <span className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">Since</span>
                <Input
                    type="date"
                    value={value.since}
                    onChange={(event) => onChange({ ...value, since: event.target.value })}
                />
            </label>
            <label className="space-y-2">
                <span className="font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground">Limit</span>
                <Input
                    type="number"
                    min={1}
                    max={500}
                    value={value.limit}
                    onChange={(event) => onChange({ ...value, limit: Number.parseInt(event.target.value || "30", 10) })}
                />
            </label>
            <label className="flex items-center gap-3 rounded-xl border border-secondary/20 bg-secondary/10 px-4 py-3">
                <Switch
                    checked={value.includeShorts}
                    onCheckedChange={(checked) => onChange({ ...value, includeShorts: checked })}
                />
                <span className="text-sm">Include shorts</span>
            </label>
        </div>
    );
}
