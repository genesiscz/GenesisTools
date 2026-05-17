import { useEffect, useState } from "react";

interface NowMarkerProps {
    /** Top offset in pixels within the timeline scroll area. */
    topPx: number;
}

export function NowMarker({ topPx }: NowMarkerProps) {
    const [visible, setVisible] = useState(true);

    // Blink the dot every second for a subtle live indicator
    useEffect(() => {
        const id = setInterval(() => setVisible((v) => !v), 1000);
        return () => clearInterval(id);
    }, []);

    return (
        <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: `${topPx}px` }}>
            {/* Glowing dot on the left */}
            <div
                className={[
                    "ml-2 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 transition-opacity duration-300",
                    visible ? "opacity-100" : "opacity-30",
                ].join(" ")}
                style={{
                    boxShadow: "0 0 6px 2px rgba(251,191,36,0.7), 0 0 16px 4px rgba(251,191,36,0.35)",
                }}
            />
            {/* Amber line */}
            <div
                className="h-px flex-1"
                style={{
                    background: "rgba(251,191,36,0.85)",
                    boxShadow: "0 0 4px 1px rgba(251,191,36,0.5)",
                }}
            />
        </div>
    );
}
