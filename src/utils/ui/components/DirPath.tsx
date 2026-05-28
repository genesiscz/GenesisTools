import {
    collapsePathForDisplay,
    formatPathForDisplay,
    longestCommonPathPrefix,
    shortenPathWithPrefix,
    toPosixPath,
} from "@app/utils/paths.client";
import {
    createContext,
    useContext,
    useMemo,
    type ReactElement,
    type ReactNode,
} from "react";

const DirPathPrefixContext = createContext<string>("");

interface DirPathPrefixProviderProps {
    paths: readonly string[];
    children: ReactNode;
}

export function DirPathPrefixProvider({ paths, children }: DirPathPrefixProviderProps): ReactElement {
    const prefix = useMemo(() => longestCommonPathPrefix(paths), [paths]);

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
    const title = showFullPathTitle ? full : undefined;
    const truncateClass =
        truncate === "tail" ? "truncate-mono-tail min-w-0" : truncate === "end" ? "truncate-mono min-w-0" : "";

    if (truncate === "tail") {
        return (
            <span className={`${truncateClass} ${className ?? ""}`.trim()} title={title}>
                <span className="truncate-mono-tail__text">{display}</span>
            </span>
        );
    }

    return (
        <span className={`${truncateClass} ${className ?? ""}`.trim()} title={title}>
            {display}
        </span>
    );
}
