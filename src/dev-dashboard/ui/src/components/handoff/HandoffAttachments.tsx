import type { PublicHandoff } from "@app/dev-dashboard/lib/handoff-types";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { attachmentUrl } from "./useHandoffApi";

type AttachmentMeta = PublicHandoff["attachments"][number];

function isImage(a: AttachmentMeta): boolean {
    return a.mime.startsWith("image/");
}

const FILE_CHIP_PATTERN = /\[File#(a_[a-z0-9]+)\]/g;

/**
 * Splits `text` on `[File#id]` refs, rendering known ids as inline attachment
 * chips (interactive — reuses `AttachmentChip`, incl. onError fallback) and
 * leaving unknown ids as literal text. Plain-text segments render as-is
 * unless `renderSegment` (e.g. markdown) is supplied (G10).
 */
export function renderWithFileChips(
    text: string,
    attachments: AttachmentMeta[],
    renderSegment: (segment: string, key: string) => ReactNode = (segment) => segment
): ReactNode[] {
    const byId = new Map(attachments.map((a) => [a.attachmentId, a]));
    const pattern = new RegExp(FILE_CHIP_PATTERN);
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    let n = 0;
    let match = pattern.exec(text);

    while (match !== null) {
        const [full, id] = match;

        if (match.index > lastIndex) {
            parts.push(renderSegment(text.slice(lastIndex, match.index), `t-${n}`));
            n += 1;
        }

        const attachment = byId.get(id);
        parts.push(attachment !== undefined ? <AttachmentChip key={`c-${n}`} attachment={attachment} /> : full);
        n += 1;
        lastIndex = match.index + full.length;
        match = pattern.exec(text);
    }

    if (lastIndex < text.length) {
        parts.push(renderSegment(text.slice(lastIndex), `t-${n}`));
    }

    return parts;
}

function BrokenFileChip({ filename }: { filename: string }) {
    return (
        <span
            className="inline-flex items-center gap-1 rounded border border-dashed border-[var(--dd-border)] px-2 py-1 font-mono text-[10px] text-[var(--dd-text-muted)] line-through"
            title="attachment file missing on disk"
        >
            ⚠ {filename}
        </span>
    );
}

function Lightbox({ attachment, onClose }: { attachment: AttachmentMeta; onClose: () => void }) {
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const closeRef = useRef<HTMLButtonElement | null>(null);
    const [broken, setBroken] = useState(false);

    useEffect(() => {
        const previouslyFocused = document.activeElement as HTMLElement | null;
        closeRef.current?.focus();

        const onKeyDown = (ev: KeyboardEvent): void => {
            if (ev.key === "Escape") {
                onClose();
                return;
            }

            if (ev.key !== "Tab" || dialogRef.current === null) {
                return;
            }

            const focusable = dialogRef.current.querySelectorAll<HTMLElement>("a[href], button");
            if (focusable.length === 0) {
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (ev.shiftKey && document.activeElement === first) {
                ev.preventDefault();
                last.focus();
            } else if (!ev.shiftKey && document.activeElement === last) {
                ev.preventDefault();
                first.focus();
            }
        };

        document.addEventListener("keydown", onKeyDown);

        return () => {
            document.removeEventListener("keydown", onKeyDown);
            previouslyFocused?.focus();
        };
    }, [onClose]);

    return (
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={`attachment preview: ${attachment.filename}`}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-8"
            onClick={onClose}
        >
            {broken ? (
                <BrokenFileChip filename={attachment.filename} />
            ) : (
                <img
                    src={attachmentUrl(attachment.attachmentId)}
                    alt={attachment.filename}
                    className="max-h-[80vh] max-w-[90vw] rounded border border-[var(--dd-border)] object-contain"
                    onError={() => setBroken(true)}
                />
            )}
            <div
                className="flex items-center gap-3 font-mono text-xs text-[var(--dd-text-secondary)]"
                onClick={(ev) => ev.stopPropagation()}
            >
                <span>{attachment.filename}</span>
                <span className="text-[var(--dd-text-muted)]">
                    {attachment.by.sessionName ?? attachment.by.agent} · {new Date(attachment.ts).toLocaleString()}
                </span>
                <a
                    href={attachmentUrl(attachment.attachmentId)}
                    download={attachment.filename}
                    className="dd-accent-text hover:opacity-80"
                >
                    download
                </a>
                <button
                    ref={closeRef}
                    type="button"
                    className="dd-accent-text cursor-pointer hover:opacity-80"
                    onClick={onClose}
                >
                    close
                </button>
            </div>
        </div>
    );
}

export function AttachmentChip({ attachment }: { attachment: AttachmentMeta }) {
    const [open, setOpen] = useState(false);
    const [broken, setBroken] = useState(false);

    if (attachment.missing === true || broken) {
        return <BrokenFileChip filename={attachment.filename} />;
    }

    if (isImage(attachment)) {
        return (
            <>
                <button
                    type="button"
                    className="cursor-zoom-in rounded border border-[var(--dd-border)] bg-black/25 p-0.5 transition-opacity hover:opacity-80"
                    onClick={() => setOpen(true)}
                    title={`${attachment.filename}${attachment.note ? ` — ${attachment.note}` : ""}`}
                >
                    <img
                        src={attachmentUrl(attachment.attachmentId)}
                        alt={attachment.filename}
                        className="h-16 w-24 rounded-sm object-cover"
                        loading="lazy"
                        onError={() => setBroken(true)}
                    />
                </button>
                {open ? <Lightbox attachment={attachment} onClose={() => setOpen(false)} /> : null}
            </>
        );
    }

    return (
        <a
            href={attachmentUrl(attachment.attachmentId)}
            download={attachment.filename}
            className="inline-flex items-center gap-1 rounded border border-[var(--dd-border)] bg-black/20 px-2 py-1 font-mono text-[10px] text-[var(--dd-text-secondary)] hover:border-primary/60"
            title={attachment.note ?? attachment.filename}
        >
            📎 {attachment.filename}
        </a>
    );
}

export function AttachmentStrip({ attachments, ids }: { attachments: AttachmentMeta[]; ids?: string[] }) {
    const visible = ids !== undefined ? attachments.filter((a) => ids.includes(a.attachmentId)) : attachments;

    if (visible.length === 0) {
        return null;
    }

    return (
        <div className="flex flex-wrap items-center gap-2">
            {visible.map((a) => (
                <AttachmentChip key={a.attachmentId} attachment={a} />
            ))}
        </div>
    );
}
