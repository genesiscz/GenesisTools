import type { AnnotationDto, Region } from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SyntheticEvent, useEffect, useState } from "react";
import { boardsApi } from "./boards-api";

interface Face {
    blobKey: string;
    caption: string;
    pending: boolean;
    attemptId: number | null;
}

function Lightbox({ blobKey, region, onClose }: { blobKey: string; region: Region; onClose: () => void }) {
    const [displayed, setDisplayed] = useState<{ w: number; h: number; naturalW: number } | null>(null);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    const factor = displayed ? displayed.w / displayed.naturalW : null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
            <div className="relative">
                <img
                    src={paths.boardsBlob(blobKey)}
                    alt="attempt face"
                    onLoad={(e: SyntheticEvent<HTMLImageElement>) =>
                        setDisplayed({
                            w: e.currentTarget.clientWidth,
                            h: e.currentTarget.clientHeight,
                            naturalW: e.currentTarget.naturalWidth || e.currentTarget.clientWidth,
                        })
                    }
                    className="max-h-[90vh] max-w-[90vw]"
                />
                {factor ? (
                    <div
                        className="absolute border-2 border-[var(--dd-danger)]"
                        style={{
                            left: region.x * factor,
                            top: region.y * factor,
                            width: region.w * factor,
                            height: region.h * factor,
                        }}
                    />
                ) : null}
            </div>
        </div>
    );
}

interface CompareDeckProps {
    slug: string;
    annotation: AnnotationDto;
}

/** Stacked before/after deck for an annotation's attempts. Shows one face at a time — the
 * card_version the annotation was drawn on, then each attempt's after face — cycled via the
 * ↻ button or ←/→ while focused. */
export function CompareDeck({ slug, annotation }: CompareDeckProps) {
    const queryClient = useQueryClient();
    const [index, setIndex] = useState(0);
    const [lightboxOpen, setLightboxOpen] = useState(false);

    const versionsQuery = useQuery({
        queryKey: ["card-versions", annotation.cardId],
        queryFn: () => boardsApi.cardVersions(annotation.cardId),
    });

    const beforeBlobKey = versionsQuery.data?.versions.find((v) => v.version === annotation.cardVersion)?.blobKey;

    const faces: Face[] = [
        ...(beforeBlobKey ? [{ blobKey: beforeBlobKey, caption: "before", pending: false, attemptId: null }] : []),
        ...annotation.attempts.map((a, i) => ({
            blobKey: a.afterBlobKey,
            caption: `after №${i + 1} · ${a.agent || "agent"} · ${a.commitRef || "no ref"}`,
            pending: a.verdict === "",
            attemptId: a.id,
        })),
    ];

    useEffect(() => {
        setIndex((i) => (i >= faces.length ? 0 : i));
    }, [faces.length]);

    const verdictMutation = useMutation({
        mutationFn: ({ attemptId, verdict }: { attemptId: number; verdict: "accept" | "reject" }) =>
            boardsApi.verdict(attemptId, verdict),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["board", slug] });
        },
    });

    if (faces.length === 0) {
        return null;
    }

    const face = faces[Math.min(index, faces.length - 1)];
    const cycle = () => setIndex((i) => (i + 1) % faces.length);

    return (
        <div className="border-b border-[var(--dd-border)] p-3">
            <div
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === "ArrowRight") {
                        setIndex((i) => (i + 1) % faces.length);
                    } else if (e.key === "ArrowLeft") {
                        setIndex((i) => (i - 1 + faces.length) % faces.length);
                    }
                }}
                className="relative outline-none"
            >
                <button type="button" onClick={() => setLightboxOpen(true)} className="block w-full">
                    <img
                        src={paths.boardsBlob(face.blobKey)}
                        alt={face.caption}
                        className="w-full rounded-md ring-1 ring-[var(--dd-border)]"
                    />
                </button>
                {faces.length > 1 ? (
                    <button
                        type="button"
                        onClick={cycle}
                        title="cycle before/after"
                        className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
                    >
                        ↻
                    </button>
                ) : null}
            </div>
            <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-[var(--dd-text-muted)]">
                {face.pending ? (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--dd-accent-from)]" />
                ) : null}
                <span>{face.caption}</span>
            </div>
            {face.pending && face.attemptId != null ? (
                <div className="mt-1 flex gap-2 text-xs">
                    <button
                        type="button"
                        onClick={() =>
                            verdictMutation.mutate({ attemptId: face.attemptId as number, verdict: "accept" })
                        }
                        className="text-[var(--dd-accent-from)] hover:underline"
                    >
                        ✓ accept
                    </button>
                    <button
                        type="button"
                        onClick={() =>
                            verdictMutation.mutate({ attemptId: face.attemptId as number, verdict: "reject" })
                        }
                        className="text-[var(--dd-danger)] hover:underline"
                    >
                        ✗ reject
                    </button>
                </div>
            ) : null}
            {lightboxOpen ? (
                <Lightbox blobKey={face.blobKey} region={annotation.region} onClose={() => setLightboxOpen(false)} />
            ) : null}
        </div>
    );
}
