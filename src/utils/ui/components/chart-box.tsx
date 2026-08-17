import { type ReactNode, useEffect, useRef, useState } from "react";

interface ChartBoxProps {
    height: number;
    children: (size: { width: number; height: number }) => ReactNode;
    className?: string;
}

/**
 * Replacement for recharts <ResponsiveContainer>. ResponsiveContainer renders
 * its child chart with width=-1 on the first frame (before measuring), which
 * triggers a noisy "width(-1) and height(-1) of chart should be greater than 0"
 * dev-mode warning per chart per mount. ChartBox uses ResizeObserver and only
 * renders the chart once a positive width is known — no warning, same UX.
 */
export function ChartBox({ height, children, className }: ChartBoxProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    useEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }

        const observer = new ResizeObserver(([entry]) => {
            const w = Math.floor(entry.contentRect.width);
            if (w > 0) {
                setWidth(w);
            }
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    return (
        <div ref={ref} style={{ height }} className={className ?? "w-full"}>
            {width > 0 ? children({ width, height }) : null}
        </div>
    );
}
