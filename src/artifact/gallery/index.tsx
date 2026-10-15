/// <reference types="vite/client" />
// The kit gallery: one page per component, found by a glob, so a new .tsx file in this folder shows up with no
// other edit. It renders on the auto template (light by day, dark by night) so both schemes can be checked.
import "../runtime/templates/auto/theme.css";
import { Hero, Page, ThemeToggle } from "@artifact/kit";
import { type ComponentType, useEffect, useState } from "react";
import { type GalleryMeta, InGallery } from "./_frame";

interface PageModule {
    default?: ComponentType;
    meta?: GalleryMeta;
}

export interface GalleryEntry {
    id: string;
    title: string;
    summary?: string;
    Component: ComponentType;
}

/** Turn "./filter-chips.tsx" into "filter-chips", and that into "Filter chips". */
export function galleryEntries(modules: Record<string, PageModule>): GalleryEntry[] {
    const entries: GalleryEntry[] = [];

    for (const [path, mod] of Object.entries(modules)) {
        const id = path.replace(/^\.\//, "").replace(/\.tsx$/, "");

        if (id === "index" || id.startsWith("_") || !mod.default) {
            continue;
        }

        const fallback = id.replace(/-/g, " ");
        entries.push({
            id,
            title: mod.meta?.title ?? fallback.charAt(0).toUpperCase() + fallback.slice(1),
            summary: mod.meta?.summary,
            Component: mod.default,
        });
    }

    return entries.sort((a, b) => a.title.localeCompare(b.title));
}

const ENTRIES = galleryEntries(import.meta.glob<PageModule>("./*.tsx", { eager: true }));

function currentId(): string {
    const hash = decodeURIComponent(window.location.hash.slice(1));

    return ENTRIES.some((e) => e.id === hash) ? hash : (ENTRIES[0]?.id ?? "");
}

export default function KitGallery() {
    const [active, setActive] = useState(currentId);

    useEffect(() => {
        const onHash = (): void => setActive(currentId());
        window.addEventListener("hashchange", onHash);

        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    const entry = ENTRIES.find((e) => e.id === active);

    return (
        <Page width="max-w-7xl">
            <Hero
                kicker="Artifact kit"
                title="Component gallery"
                subtitle={`${ENTRIES.length} pages, one per component. Each shows the defaults, one edge case and its keyboard use.`}
            >
                <div className="mt-3">
                    <ThemeToggle />
                </div>
            </Hero>
            <div className="grid gap-6 md:grid-cols-[13rem_1fr]">
                <nav aria-label="Components" className="md:sticky md:top-4 md:self-start">
                    <ul className="flex flex-wrap gap-1 md:flex-col">
                        {ENTRIES.map((e) => (
                            <li key={e.id}>
                                <a
                                    href={`#${e.id}`}
                                    aria-current={e.id === active ? "page" : undefined}
                                    className={`block rounded-card px-3 py-1.5 text-sm ${
                                        e.id === active
                                            ? "bg-accent/15 font-medium text-accent"
                                            : "text-dim hover:bg-panel hover:text-ink"
                                    }`}
                                >
                                    {e.title}
                                </a>
                            </li>
                        ))}
                    </ul>
                </nav>
                <div className="min-w-0">
                    {entry ? (
                        <InGallery.Provider value={true}>
                            <h2 className="text-xl font-semibold text-ink">{entry.title}</h2>
                            {entry.summary ? <p className="mt-1 mb-4 text-dim">{entry.summary}</p> : null}
                            <entry.Component key={entry.id} />
                        </InGallery.Provider>
                    ) : (
                        <p className="text-dim">No gallery pages found.</p>
                    )}
                </div>
            </div>
        </Page>
    );
}
