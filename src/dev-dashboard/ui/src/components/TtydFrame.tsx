import { useEffect, useState } from "react";

interface TtydFrameProps {
    id: string;
    title: string;
    className?: string;
}

const RETRY_MS = 600;
const MAX_ATTEMPTS = 30; // ~18s — covers spawn→bind + a dashboard restart

/**
 * ttyd binds its port ~100-300ms AFTER spawnTtyd returns, so the iframe's
 * first request races the bind and the front-proxy answers 502
 * ("Bad Gateway: upstream unavailable") until it's up. Poll readiness first
 * and only mount the iframe once /ttyd/<id>/ returns 200 — the user never
 * sees the gateway page and never has to refresh.
 */
export function TtydFrame({ id, title, className }: TtydFrameProps) {
    const src = `/ttyd/${encodeURIComponent(id)}/`;
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        let attempts = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        setReady(false);
        setFailed(false);

        const probe = async () => {
            attempts += 1;
            try {
                const res = await fetch(src, { method: "GET", cache: "no-store" });
                if (!cancelled && res.ok) {
                    setReady(true);
                    return;
                }
            } catch {
                // network blip while ttyd is coming up — fall through to retry
            }

            if (cancelled) {
                return;
            }

            if (attempts >= MAX_ATTEMPTS) {
                setFailed(true);
                return;
            }

            timer = setTimeout(probe, RETRY_MS);
        };

        probe();

        return () => {
            cancelled = true;
            if (timer) {
                clearTimeout(timer);
            }
        };
    }, [src]);

    if (failed) {
        return (
            <div className={`flex items-center justify-center bg-black text-[var(--dd-text-muted)] ${className ?? ""}`}>
                terminal unreachable — the session may have exited
            </div>
        );
    }

    if (!ready) {
        return (
            <div className={`flex items-center justify-center bg-black text-[var(--dd-text-muted)] ${className ?? ""}`}>
                connecting…
            </div>
        );
    }

    return (
        <div className={`dd-ttyd-embed ${className ?? ""}`.trim()}>
            <iframe src={src} title={title} tabIndex={-1} />
        </div>
    );
}
