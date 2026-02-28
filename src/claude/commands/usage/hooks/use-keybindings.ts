import { useApp, useInput } from "ink";
import { useState } from "react";

interface KeybindingsOptions {
    onForceRefresh: () => void;
    onDismissAlert: () => void;
    onCycleInterval: () => void;
    onTogglePause: () => void;
}

export function useKeybindings({ onForceRefresh, onDismissAlert, onCycleInterval, onTogglePause }: KeybindingsOptions) {
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

        if (input === "?") {
            setShowHelp((h) => !h);
        }
    });

    return { showHelp, setShowHelp };
}
