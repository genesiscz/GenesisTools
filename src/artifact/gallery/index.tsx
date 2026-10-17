/// <reference types="vite/client" />
// The kit gallery: one page per component family, found by a glob, so a new .tsx file in this folder shows up with
// no other edit. It renders on the auto template (light by day, dark by night) so both schemes can be checked.
import "../runtime/templates/auto/theme.css";
import { FOCUS_RING, Hero, Page, ThemeToggle } from "@artifact/kit";
import { useEffect, useMemo, useState } from "react";
import { filterGalleryEntries, type GalleryPageModule, galleryEntries, galleryPageId, groupByFamily } from "./_entries";
import { InGallery } from "./_frame";

const ENTRIES = galleryEntries(import.meta.glob<GalleryPageModule>("./*.tsx", { eager: true }));
const FAMILY_COUNT = groupByFamily(ENTRIES).length;

/**
 * The open page lives in `?page=<id>`, not in the hash: Tabs and TimeSeries on a page own the hash (a tab id and
 * chart views), and a gallery id there would be overwritten by the first tab click. An old `#<id>` link still works.
 */
function currentId(): string {
    return galleryPageId(ENTRIES, new URL(window.location.href));
}

function pageHref(id: string): string {
    return `?page=${encodeURIComponent(id)}`;
}

export default function KitGallery() {
    const [active, setActive] = useState(currentId);
    const [query, setQuery] = useState("");
    const groups = useMemo(() => groupByFamily(filterGalleryEntries(ENTRIES, query)), [query]);

    useEffect(() => {
        const url = new URL(window.location.href);
        url.searchParams.set("page", currentId());
        history.replaceState(null, "", url);
        const onPop = (): void => setActive(currentId());
        window.addEventListener("popstate", onPop);

        return () => window.removeEventListener("popstate", onPop);
    }, []);

    const go = (id: string): void => {
        if (id === active) {
            return;
        }

        history.pushState(null, "", pageHref(id));
        setActive(id);
        window.scrollTo({ top: 0 });
    };

    const entry = ENTRIES.find((e) => e.id === active);
    const firstMatch = groups[0]?.entries[0];

    return (
        <Page width="max-w-7xl">
            <Hero
                kicker="Artifact kit"
                title="Component gallery"
                subtitle={`${ENTRIES.length} pages in ${FAMILY_COUNT} families. Each shows the defaults, one edge case and its keyboard use.`}
            >
                <div className="mt-3">
                    <ThemeToggle />
                </div>
            </Hero>
            <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
                <nav aria-label="Components" className="md:sticky md:top-4 md:self-start">
                    <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && firstMatch) {
                                go(firstMatch.id);
                            }

                            if (e.key === "Escape") {
                                setQuery("");
                            }
                        }}
                        placeholder="Search components"
                        aria-label="Search components"
                        className={`mb-3 w-full rounded-card border border-line bg-panel px-3 py-1.5 text-sm text-ink placeholder:text-dim ${FOCUS_RING}`}
                    />
                    {groups.length === 0 ? <p className="px-3 text-sm text-dim">No page matches.</p> : null}
                    <div className="flex flex-col gap-3 md:max-h-[calc(100vh-8rem)] md:overflow-y-auto">
                        {groups.map((group) => (
                            <section key={group.family} aria-label={group.family}>
                                <h3 className="px-3 pb-1 text-xs font-semibold text-dim">{group.family}</h3>
                                <ul className="flex flex-wrap gap-1 md:flex-col">
                                    {group.entries.map((e) => (
                                        <li key={e.id}>
                                            <a
                                                href={pageHref(e.id)}
                                                onClick={(event) => {
                                                    if (event.metaKey || event.ctrlKey || event.shiftKey) {
                                                        return;
                                                    }

                                                    event.preventDefault();
                                                    go(e.id);
                                                }}
                                                title={e.summary}
                                                aria-current={e.id === active ? "page" : undefined}
                                                className={`block rounded-card px-3 py-1.5 text-sm ${FOCUS_RING} ${
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
                            </section>
                        ))}
                    </div>
                </nav>
                <div className="min-w-0">
                    {entry ? (
                        <InGallery.Provider value={true}>
                            <p className="text-xs text-dim">{entry.family}</p>
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
