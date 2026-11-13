import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export interface StickyControlsProps {
    children: ReactNode;
    /** Keep controls below the nearest Page's TopNav. Default on. */
    sticky?: boolean;
    /** Space below the measured navigation, in pixels. */
    gap?: number;
    label?: string;
}

/** A shared blurred control panel that measures the page navigation instead of assuming its height. */
export function StickyControls({ children, sticky = true, gap = 4, label = "Controls" }: StickyControlsProps) {
    const panel = useRef<HTMLDivElement>(null);
    const [navHeight, setNavHeight] = useState(0);

    useLayoutEffect(() => {
        const scope = panel.current?.closest("[data-artifact-page]") ?? document;
        const nav = scope.querySelector("[data-artifact-topnav]");
        if (!nav) {
            setNavHeight(0);
            return;
        }

        const measure = () => setNavHeight(nav.getBoundingClientRect().height);
        measure();
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
        observer?.observe(nav);
        window.addEventListener("resize", measure);
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, []);

    return (
        <div
            ref={panel}
            role="region"
            aria-label={label}
            data-sticky-controls=""
            className={`akit-sticky-controls ${sticky ? "sticky" : "relative"} z-[5] flex flex-col gap-2.5 rounded-card border border-line px-3.5 py-2.5 backdrop-blur-[14px]`}
            style={{ top: sticky ? navHeight + gap : undefined }}
        >
            {children}
        </div>
    );
}
