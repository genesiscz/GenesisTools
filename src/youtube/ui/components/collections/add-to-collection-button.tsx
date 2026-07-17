import { Button } from "@app/utils/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@app/utils/ui/components/dropdown-menu";
import type { CollectionRecord } from "@app/youtube/lib/db.types";
import { useAddCollectionVideo, useCollections, useMe } from "@app/yt/api.hooks";
import { Link } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { toast } from "sonner";

export function AddToCollectionButton({ videoId }: { videoId: string }) {
    const me = useMe();
    const collections = useCollections();

    if (!me.data) {
        return null;
    }

    const manual = (collections.data ?? []).filter((collection) => collection.kind === "manual");

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                    <FolderPlus className="size-4" /> Add to collection
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                <DropdownMenuLabel>Add to a manual collection</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {manual.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        No manual collections yet.{" "}
                        <Link to="/collections" className="underline">
                            Create one
                        </Link>
                    </div>
                ) : (
                    manual.map((collection) => (
                        <AddCollectionItem key={collection.id} collection={collection} videoId={videoId} />
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function AddCollectionItem({ collection, videoId }: { collection: CollectionRecord; videoId: string }) {
    const add = useAddCollectionVideo(collection.id);

    return (
        <DropdownMenuItem
            disabled={add.isPending}
            onSelect={(event) => {
                event.preventDefault();
                add.mutate(videoId, {
                    onSuccess: (result) => {
                        if (result.added) {
                            toast.success(`Added to ${collection.name}`);
                        } else {
                            toast.info(`Already in ${collection.name}`);
                        }
                    },
                });
            }}
        >
            {collection.name}
        </DropdownMenuItem>
    );
}
