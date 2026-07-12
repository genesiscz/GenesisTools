import { cn } from "@ui/lib/utils";
import { BookOpen, FileText, ScrollText } from "lucide-react";
import type { ReadingType } from "@/lib/reading/hooks/useReading";

interface BookCoverProps {
    title: string;
    coverUrl?: string | null;
    type: ReadingType;
    className?: string;
}

// Deterministic decorative gradient seeded from the title. This is media art,
// not chrome — arbitrary hues are intentional (design doc: media scrim carve-out).
// allow-palette: generated decorative book-cover gradient (media, not surface)
const COVER_GRADIENTS = [
    "linear-gradient(135deg, #6d28d9, #4338ca)",
    "linear-gradient(135deg, #be123c, #9333ea)",
    "linear-gradient(135deg, #0f766e, #155e75)",
    "linear-gradient(135deg, #b45309, #9f1239)",
    "linear-gradient(135deg, #1d4ed8, #6d28d9)",
    "linear-gradient(135deg, #15803d, #0f766e)",
    "linear-gradient(135deg, #c026d3, #6d28d9)",
    "linear-gradient(135deg, #475569, #1e293b)",
];

function hashTitle(title: string): number {
    let hash = 0;
    for (let i = 0; i < title.length; i++) {
        hash = (hash * 31 + title.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

const TYPE_ICON = {
    book: BookOpen,
    article: FileText,
    paper: ScrollText,
};

export function BookCover({ title, coverUrl, type, className }: BookCoverProps) {
    const gradient = COVER_GRADIENTS[hashTitle(title) % COVER_GRADIENTS.length];
    const TypeIcon = TYPE_ICON[type];

    if (coverUrl) {
        return (
            <div className={cn("relative overflow-hidden rounded-md", className)}>
                <img src={coverUrl} alt={`Cover of ${title}`} className="h-full w-full object-cover" />
            </div>
        );
    }

    return (
        <div
            className={cn(
                "relative flex flex-col justify-between overflow-hidden rounded-md p-3 text-white shadow-lg",
                className
            )}
            // allow-palette: generated decorative cover gradient (media scrim)
            style={{ background: gradient }}
            aria-label={`Generated cover for ${title}`}
        >
            {/* Spine sheen */}
            <div className="pointer-events-none absolute inset-y-0 left-0 w-[6px] bg-black/25" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-white/10" />
            <TypeIcon className="relative h-5 w-5 opacity-80" />
            <span className="relative line-clamp-4 text-[13px] font-semibold leading-snug tracking-tight">{title}</span>
        </div>
    );
}
