import {
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
    useCallback,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { usePersistedState } from "@/lib/persisted-state";

// One reading width for every page that reads long text (the Q&A feed, an Obsidian
// note), like the Genesis Markdown viewer's column: drag a grip to resize, double-click
// or Enter to go back to the full width. null = as wide as the page.
const WIDTH_KEY = "dd:reading-width";
const MIN_WIDTH = 420;

function parseWidth(raw: unknown): number | null {
    return typeof raw === "number" && Number.isFinite(raw) && raw >= MIN_WIDTH ? raw : null;
}

interface Props {
    children: ReactNode;
    className?: string;
}

export function ReadingColumn({ children, className }: Props) {
    const [saved, setSaved, resetSaved] = usePersistedState<number | null>(WIDTH_KEY, parseWidth, null);
    // The width while a drag runs; it is saved once, on release.
    const [dragWidth, setDragWidth] = useState<number | null>(null);
    const columnRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startWidth: number; sign: number; width: number | null } | null>(null);
    const width = dragWidth ?? saved;

    useLayoutEffect(() => {
        const column = columnRef.current;
        const parent = column?.parentElement;

        if (!column || !parent) {
            return;
        }

        const update = () => {
            const current = Math.round(column.getBoundingClientRect().width);
            const maximum = Math.max(current, parent.clientWidth);
            const minimum = Math.min(MIN_WIDTH, maximum);

            for (const grip of column.querySelectorAll<HTMLElement>(":scope > .dd-reading-grip")) {
                grip.setAttribute("aria-valuemin", String(minimum));
                grip.setAttribute("aria-valuemax", String(maximum));
                grip.setAttribute("aria-valuenow", String(current));
                grip.setAttribute("aria-valuetext", `${current} pixels`);
            }
        };

        update();
        const observer = new ResizeObserver(update);
        observer.observe(column);
        observer.observe(parent);

        return () => observer.disconnect();
    }, [width]);

    const clamp = useCallback((value: number) => {
        const available = columnRef.current?.parentElement?.clientWidth ?? value;

        return Math.round(Math.max(MIN_WIDTH, Math.min(Math.max(MIN_WIDTH, available), value)));
    }, []);

    const onPointerDown = (sign: number) => (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !columnRef.current) {
            return;
        }

        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            startX: event.clientX,
            startWidth: columnRef.current.getBoundingClientRect().width,
            sign,
            width: null,
        };
        document.body.classList.add("dd-reading-resizing");
    };

    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;

        if (!drag) {
            return;
        }

        // The column is centred, so one edge moving by dx widens it by 2 * dx.
        drag.width = clamp(drag.startWidth + drag.sign * (event.clientX - drag.startX) * 2);
        setDragWidth(drag.width);
    };

    const endDrag = (commit: boolean) => {
        const drag = dragRef.current;

        if (!drag) {
            return;
        }

        dragRef.current = null;
        document.body.classList.remove("dd-reading-resizing");

        if (commit && drag.width !== null) {
            setSaved(drag.width);
        }

        setDragWidth(null);
    };

    const onKeyDown = (sign: number) => (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            resetSaved();
            return;
        }

        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
        }

        event.preventDefault();
        const current = columnRef.current?.getBoundingClientRect().width ?? MIN_WIDTH;
        const dx = (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 60 : 20);
        setSaved(clamp(current + sign * dx * 2));
    };

    const grip = (sign: number) => (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Reading width"
            aria-keyshortcuts="ArrowLeft ArrowRight Enter"
            tabIndex={0}
            title="Drag to resize, double-click for the full width"
            className={`dd-reading-grip ${sign > 0 ? "dd-reading-grip-r" : "dd-reading-grip-l"}${dragWidth !== null ? " dd-reading-grip-active" : ""}`}
            onPointerDown={onPointerDown(sign)}
            onPointerMove={onPointerMove}
            onPointerUp={() => endDrag(true)}
            onPointerCancel={() => endDrag(false)}
            onLostPointerCapture={() => endDrag(true)}
            onDoubleClick={(event) => {
                event.preventDefault();
                resetSaved();
            }}
            onKeyDown={onKeyDown(sign)}
        />
    );

    return (
        <div
            ref={columnRef}
            className={`dd-reading-column${className ? ` ${className}` : ""}`}
            style={width !== null ? { maxWidth: `${width}px` } : undefined}
        >
            {grip(-1)}
            {children}
            {grip(1)}
        </div>
    );
}
