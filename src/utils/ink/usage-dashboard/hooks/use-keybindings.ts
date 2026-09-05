import { useApp, useInput } from "ink";
import { useState } from "react";

interface KeybindingsOptions {
    onForceRefresh: () => void;
    onDismissAlert: () => void;
    onCycleInterval: () => void;
    onTogglePause: () => void;
    onToggleSort: () => void;
    /** `P` cycles the provider filter. Absent on a single-provider dashboard. */
    onCycleProvider?: () => void;
    /** `a` opens the account checklist. */
    onOpenAccountFilter?: () => void;
}

export function useKeybindings({
    onForceRefresh,
    onDismissAlert,
    onCycleInterval,
    onTogglePause,
    onToggleSort,
    onCycleProvider,
    onOpenAccountFilter,
}: KeybindingsOptions) {
    const { exit } = useApp();
    const [showHelp, setShowHelp] = useState(false);

    useInput((input) => {
        if (input === "q") {
            exit();
        }

        if (input === "r") {
            onForceRefresh();
        }

        if (input === "p") {
            onTogglePause();
        }

        if (input === "i") {
            onCycleInterval();
        }

        if (input === "x") {
            onDismissAlert();
        }

        if (input === "s") {
            onToggleSort();
        }

        if (input === "P" && onCycleProvider) {
            onCycleProvider();
        }

        if (input === "a" && onOpenAccountFilter) {
            onOpenAccountFilter();
        }

        if (input === "?") {
            setShowHelp((h) => !h);
        }
    });

    return { showHelp, setShowHelp };
}
