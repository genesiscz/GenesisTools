import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Mosaic, type MosaicNode, MosaicWindow } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";
import { Button } from "@ui/components/button";
import { TtydPane } from "@/components/TtydPane";
import { ttydApi } from "@/lib/api";
import { reconcileMosaicLayout } from "@/lib/mosaic-layout";

export function TtydRoute() {
    const queryClient = useQueryClient();
    const { data } = useQuery({ queryKey: ["ttyd", "list"], queryFn: ttydApi.list });
    const sessions = data?.sessions ?? [];
    const [layout, setLayout] = useState<MosaicNode<string> | null>(null);

    useEffect(() => {
        setLayout((current) =>
            reconcileMosaicLayout(
                current,
                sessions.map((session) => session.id),
                { maxColumns: 3 }
            )
        );
    }, [sessions]);

    const spawn = useMutation({
        mutationFn: () => ttydApi.spawn(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ttyd", "list"] });
        },
    });

    const kill = useMutation({
        mutationFn: (id: string) => ttydApi.kill(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ttyd", "list"] });
        },
    });

    return (
        <div className="flex h-[calc(100vh-2rem)] flex-col gap-2">
            <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => spawn.mutate()} disabled={spawn.isPending}>
                    <Plus size={14} /> New terminal
                </Button>
                <span className="text-[11px] font-mono text-[var(--dd-text-muted)]">
                    drag dividers to resize · close a window to kill the session
                </span>
            </div>
            <div className="flex-1 overflow-hidden">
                {layout && sessions.length > 0 ? (
                    <Mosaic<string>
                        value={layout}
                        onChange={(next) => setLayout(next)}
                        renderTile={(id, path) => {
                            const session = sessions.find((candidate) => candidate.id === id);

                            if (!session) {
                                return (
                                    <div className="dd-panel flex h-full items-center justify-center p-2 text-[var(--dd-text-muted)]">
                                        session gone
                                    </div>
                                );
                            }

                            return (
                                <MosaicWindow<string>
                                    path={path}
                                    title={`${session.command.split("/").pop()} :${session.port}`}
                                    additionalControls={null}
                                    toolbarControls={
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            onClick={() => kill.mutate(session.id)}
                                            aria-label="close terminal"
                                        >
                                            <X size={12} />
                                        </Button>
                                    }
                                >
                                    <TtydPane session={session} />
                                </MosaicWindow>
                            );
                        }}
                        className="dd-mosaic"
                    />
                ) : (
                    <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                        No terminals. Click "New terminal".
                    </div>
                )}
            </div>
        </div>
    );
}
