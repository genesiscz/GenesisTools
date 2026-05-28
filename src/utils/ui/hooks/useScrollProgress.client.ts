import { useEffect, useState } from "react";

export interface ScrollProgress {
    y: number;
    ratio: number;
}

export function useScrollProgress(container?: HTMLElement | null): ScrollProgress {
    const [state, setState] = useState<ScrollProgress>({ y: 0, ratio: 0 });

    useEffect(() => {
        const target = container ?? window;

        const read = (): void => {
            const y = container ? container.scrollTop : window.scrollY;
            const max = container
                ? container.scrollHeight - container.clientHeight
                : document.documentElement.scrollHeight - window.innerHeight;

            setState({ y, ratio: max > 0 ? y / max : 0 });
        };

        read();
        target.addEventListener("scroll", read, { passive: true });
        return () => target.removeEventListener("scroll", read);
    }, [container]);

    return state;
}
