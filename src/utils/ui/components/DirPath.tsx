import { formatPathForDisplay, resolveDirPathDisplayPrefix } from "@app/utils/paths.client";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from "react";

const DirPathPrefixContext = createContext<string>("");

interface DirPathPrefixProviderProps {
    paths: readonly string[];
    children: ReactNode;
}

export function DirPathPrefixProvider({ paths, children }: DirPathPrefixProviderProps): ReactElement {
    const prefix = useMemo(() => resolveDirPathDisplayPrefix(paths), [paths]);

    return <DirPathPrefixContext.Provider value={prefix}>{children}</DirPathPrefixContext.Provider>;
}

export function useDirPathPrefix(): string {
    return useContext(DirPathPrefixContext);
}

interface DirPathProps {
    path: string;
    prefix?: string;
    className?: string;
    showFullPathTitle?: boolean;
    truncate?: "none" | "tail" | "end";
}

export function DirPath({
    path,
    prefix: prefixOverride,
    className,
    showFullPathTitle = true,
    truncate = "tail",
}: DirPathProps): ReactElement | null {
    const contextPrefix = useDirPathPrefix();
    const prefix = prefixOverride ?? contextPrefix;
    const trimmed = path.trim();

    if (!trimmed) {
        return null;
    }

    const { display, full } = formatPathForDisplay(trimmed, prefix);
    const truncateClass =
        truncate === "tail" ? "truncate-mono-tail min-w-0" : truncate === "end" ? "truncate-mono min-w-0" : "";

    const content =
        truncate === "tail" ? (
            <span className={`${truncateClass} ${className ?? ""}`.trim()}>
                <span className="truncate-mono-tail__text">{display}</span>
            </span>
        ) : (
            <span className={`${truncateClass} ${className ?? ""}`.trim()}>{display}</span>
        );

    if (!showFullPathTitle) {
        return content;
    }

    // Self-contained provider so DirPath works in any app tree (sidebar.tsx pattern)
    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>{content}</TooltipTrigger>
                <TooltipContent className="max-w-lg font-mono break-all">{full}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
