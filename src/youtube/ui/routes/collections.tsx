import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { useCollections, useCreateCollection, useDeleteCollection } from "@app/yt/api.hooks";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/collections")({
    component: CollectionsPage,
});

const KIND_PRESETS: Array<{ value: string; label: string }> = [
    { value: "manual", label: "Manual — add videos yourself" },
    { value: "watched:7", label: "Dynamic — watched last 7 days" },
    { value: "watched:30", label: "Dynamic — watched last 30 days" },
    { value: "watched:90", label: "Dynamic — watched last 90 days" },
];

function buildCreateBody(name: string, preset: string) {
    if (preset === "manual") {
        return { name, kind: "manual" as const };
    }

    const sinceDays = Number.parseInt(preset.split(":")[1] ?? "30", 10);

    return { name, kind: "dynamic" as const, rule: { type: "watched", sinceDays } };
}

function CollectionsPage() {
    const collections = useCollections();
    const create = useCreateCollection();
    const remove = useDeleteCollection();
    const navigate = useNavigate();
    const [name, setName] = useState("");
    const [preset, setPreset] = useState("manual");

    const onCreate = () => {
        const trimmed = name.trim();

        if (!trimmed || create.isPending) {
            return;
        }

        create.mutate(buildCreateBody(trimmed, preset), { onSuccess: () => setName("") });
    };

    return (
        <div className="mx-auto max-w-4xl space-y-4 p-4">
            <h1 className="text-xl font-semibold">Collections</h1>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">New collection</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <Input
                        placeholder="Collection name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                onCreate();
                            }
                        }}
                    />
                    <Select value={preset} onValueChange={setPreset}>
                        <SelectTrigger className="sm:w-72">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {KIND_PRESETS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button disabled={create.isPending || !name.trim()} onClick={onCreate}>
                        Create
                    </Button>
                </CardContent>
            </Card>

            {collections.isPending ? <p className="text-sm text-muted-foreground">Loading collections…</p> : null}
            {collections.data?.length === 0 ? (
                <p className="text-sm text-muted-foreground">No collections yet. Create one above.</p>
            ) : null}

            <div className="space-y-3">
                {(collections.data ?? []).map((collection) => (
                    <Card key={collection.id}>
                        <CardContent className="flex items-center justify-between gap-3 pt-6">
                            <button
                                type="button"
                                className="min-w-0 text-left"
                                onClick={() =>
                                    void navigate({ to: "/collections/$id", params: { id: String(collection.id) } })
                                }
                            >
                                <p className="truncate font-medium hover:underline">{collection.name}</p>
                                <div className="mt-1 flex items-center gap-2">
                                    <Badge variant="secondary">{collection.kind}</Badge>
                                    <span className="text-xs text-muted-foreground">
                                        {collection.videoCount} video{collection.videoCount === 1 ? "" : "s"}
                                    </span>
                                </div>
                            </button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={remove.isPending}
                                onClick={() => remove.mutate(collection.id)}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
