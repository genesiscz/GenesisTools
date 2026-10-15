// Shared frame for the kit gallery pages. index.tsx lists every other .tsx file in this folder by itself,
// so a new component page needs no edit anywhere else: export a default component, and optionally `meta`.
import { Hero, Note, Page, Section } from "@artifact/kit";
import { createContext, type ReactNode, useContext } from "react";

/** What index.tsx reads from a page module besides its default export. */
export interface GalleryMeta {
    title: string;
    summary?: string;
}

/** True inside index.tsx, which already draws the page chrome. */
export const InGallery = createContext(false);

export interface GalleryPageProps {
    title: string;
    summary?: string;
    /** How the component is used without a mouse. */
    keyboard?: ReactNode;
    children: ReactNode;
}

/** One component's page: its demos, then a keyboard note. Standalone it brings its own Page and Hero. */
export function GalleryPage({ title, summary, keyboard, children }: GalleryPageProps) {
    const embedded = useContext(InGallery);
    const body = (
        <>
            {children}
            {keyboard ? (
                <Section title="Keyboard">
                    <Note>{keyboard}</Note>
                </Section>
            ) : null}
        </>
    );

    if (embedded) {
        return body;
    }

    return (
        <Page>
            <Hero kicker="Artifact kit gallery" title={title} subtitle={summary} />
            {body}
        </Page>
    );
}

/** A demo block with a short caption. */
export function Demo({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
    return (
        <Section title={title} note={note}>
            {children}
        </Section>
    );
}

/** Opened directly, this helper file points at the gallery index. */
export default function FrameNote() {
    return (
        <Page>
            <Hero title="Gallery frame" subtitle="Shared helpers for the gallery pages. Open the index page instead." />
        </Page>
    );
}
