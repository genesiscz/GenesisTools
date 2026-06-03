import {
    createContext,
    type ReactElement,
    type ReactNode,
    type RefObject,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { scrollToLogLineIndex } from "@/lib/log-line-index";

const JUMP_BLINK_MS = 2_400;

interface LogLineJumpContextValue {
    jumpTargetIndex: number | null;
    jumpToLine: (index: number) => void;
    clearJump: () => void;
    registerScrollContainer: (ref: RefObject<HTMLElement | null>) => void;
}

const LogLineJumpContext = createContext<LogLineJumpContextValue | null>(null);

interface ProviderProps {
    children: ReactNode;
    /** Called before scrolling — e.g. freeze search instead of clearing it. */
    onBeforeJump?: (index: number) => void;
}

export function LogLineJumpProvider({ children, onBeforeJump }: ProviderProps): ReactElement {
    const [jumpTargetIndex, setJumpTargetIndex] = useState<number | null>(null);
    const scrollContainerRef = useRef<RefObject<HTMLElement | null> | null>(null);
    const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearJump = useCallback(() => {
        if (clearTimerRef.current !== null) {
            clearTimeout(clearTimerRef.current);
            clearTimerRef.current = null;
        }

        setJumpTargetIndex(null);
    }, []);

    const jumpToLine = useCallback(
        (index: number) => {
            if (clearTimerRef.current !== null) {
                clearTimeout(clearTimerRef.current);
            }

            onBeforeJump?.(index);
            setJumpTargetIndex(index);

            clearTimerRef.current = setTimeout(() => {
                clearTimerRef.current = null;
                setJumpTargetIndex(null);
            }, JUMP_BLINK_MS);
        },
        [onBeforeJump]
    );

    useEffect(() => {
        if (jumpTargetIndex === null) {
            return;
        }

        const frame = requestAnimationFrame(() => {
            scrollToLogLineIndex(scrollContainerRef.current?.current ?? null, jumpTargetIndex);
        });

        return () => {
            cancelAnimationFrame(frame);
        };
    }, [jumpTargetIndex]);

    const registerScrollContainer = useCallback((ref: RefObject<HTMLElement | null>) => {
        scrollContainerRef.current = ref;
    }, []);

    const value = useMemo(
        (): LogLineJumpContextValue => ({
            jumpTargetIndex,
            jumpToLine,
            clearJump,
            registerScrollContainer,
        }),
        [jumpTargetIndex, jumpToLine, clearJump, registerScrollContainer]
    );

    return <LogLineJumpContext.Provider value={value}>{children}</LogLineJumpContext.Provider>;
}

export function useLogLineJump(): LogLineJumpContextValue {
    const ctx = useContext(LogLineJumpContext);

    if (!ctx) {
        throw new Error("useLogLineJump must be used within LogLineJumpProvider");
    }

    return ctx;
}
