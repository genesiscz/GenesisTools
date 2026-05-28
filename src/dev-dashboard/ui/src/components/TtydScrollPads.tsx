import { ChevronDown, ChevronUp } from "lucide-react";
import type { RefObject } from "react";
import { scrollIframeTerminalByPage } from "@/lib/iframe-keys";

interface Props {
    iframeRef: RefObject<HTMLIFrameElement | null>;
}

export function TtydScrollPads({ iframeRef }: Props) {
    const scroll = (direction: -1 | 1) => {
        scrollIframeTerminalByPage(iframeRef.current, direction);
    };

    return (
        <div className="dd-ttyd-scroll-pads" aria-label="terminal scroll">
            <button
                type="button"
                className="dd-ttyd-scroll-pad"
                aria-label="Scroll terminal up one page"
                onClick={() => scroll(-1)}
            >
                <ChevronUp size={20} strokeWidth={2.25} />
            </button>
            <button
                type="button"
                className="dd-ttyd-scroll-pad"
                aria-label="Scroll terminal down one page"
                onClick={() => scroll(1)}
            >
                <ChevronDown size={20} strokeWidth={2.25} />
            </button>
        </div>
    );
}
