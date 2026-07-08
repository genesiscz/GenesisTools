import { useEffect, useState } from "react";
import { boardsApi } from "./boards-api";

const STORAGE_KEY = "boards-operator";

function readStored(): string {
    return typeof window === "undefined" ? "" : (window.localStorage.getItem(STORAGE_KEY) ?? "");
}

export interface UseOperatorResult {
    operator: string;
    /** True once we know whether to show the "YOU ARE" prompt (server round-trip settled). */
    promptOpen: boolean;
    /** Pre-fills the prompt from the server's current operator setting, if any. */
    serverDefault: string;
    commit: (name: string) => void;
}

/** First-visit operator identity: prompt once when localStorage is empty, persist locally,
 * and PUT back to the server only when the committed name differs from what it already had. */
export function useOperator(): UseOperatorResult {
    const [operator, setOperator] = useState(readStored);
    const [promptOpen, setPromptOpen] = useState(false);
    const [serverDefault, setServerDefault] = useState("");

    useEffect(() => {
        if (operator !== "") {
            return;
        }

        let cancelled = false;

        boardsApi
            .getOperator()
            .then((res) => {
                if (cancelled) {
                    return;
                }

                setServerDefault(res.operator);
                setPromptOpen(true);
            })
            .catch(() => {
                if (!cancelled) {
                    setPromptOpen(true);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [operator]);

    const commit = (name: string) => {
        const trimmed = name.trim();
        window.localStorage.setItem(STORAGE_KEY, trimmed);
        setOperator(trimmed);
        setPromptOpen(false);

        if (trimmed !== serverDefault) {
            void boardsApi.setOperator(trimmed);
        }
    };

    return { operator, promptOpen, serverDefault, commit };
}
