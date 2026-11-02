import { useContext } from "react";
import { PageWidthContext } from "./look";
import { MdInline } from "./md";
import { DOCUMENT_GUTTER } from "./primitives";
import { ThemeToggle } from "./theme";

export interface TopNavLink {
    /** Usually a section anchor ("#layers"). */
    href: string;
    label: string;
}

export interface TopNavProps {
    /** Inline markdown; a **bold** run is drawn in the accent. */
    brand: string;
    links?: TopNavLink[];
    /** A theme button on the right that cycles system, light and dark (needs a light-dark template such as auto or paper). */
    theme?: boolean;
}

/**
 * Sticky bar for a long page: brand, section links and an optional theme
 * button, on a blurred strip of the canvas. Pass it to `Page nav`, which puts
 * it above the content and lines its row up with the content width.
 */
export function TopNav({ brand, links = [], theme = false }: TopNavProps) {
    const width = useContext(PageWidthContext);

    return (
        <nav
            aria-label="Page sections"
            className={`sticky top-0 z-10 border-b border-line backdrop-blur-[14px] ${DOCUMENT_GUTTER}`}
            style={{ background: "color-mix(in srgb, var(--bg) 78%, transparent)" }}
        >
            <div className={`${width} mx-auto flex h-[60px] items-center gap-[18px] overflow-x-auto`}>
                <span className="whitespace-nowrap font-display text-base font-semibold leading-[normal] tracking-[0.01em] text-ink [&_strong]:text-accent!">
                    <MdInline>{brand}</MdInline>
                </span>
                {links.map((link) => (
                    <a
                        key={link.href}
                        href={link.href}
                        className="whitespace-nowrap rounded-lg px-2.5 py-1.5 font-mono text-[15px] font-medium leading-[normal] text-ink-2 no-underline transition-colors duration-200 hover:bg-panel-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info"
                    >
                        {link.label}
                    </a>
                ))}
                <span className="flex-1" />
                {theme ? <ThemeToggle variant="cycle" /> : null}
            </div>
        </nav>
    );
}
