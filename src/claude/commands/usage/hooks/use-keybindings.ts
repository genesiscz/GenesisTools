import { useApp, useInput } from "ink";
import { useState } from "react";

interface KeybindingsOptions {
    onForceRefresh: () => void;
    onDismissAlert: () => void;
}

export function useKeybindings({ onForceRefresh, onDismissAlert }: KeybindingsOptions) {
    const { exit } = useApp();
    const [paused, setPaused] = useState(false);
    const [showHelp, setShowHelp] = useState(false);

    useInput((input) => {
        if (input === "q") {
            exit();
        }

        if (input === "r") {
            onForceRefresh();
        }

        if (input === "p") {
            setPaused((p) => !p);
        }

        if (input === "x") {
            onDismissAlert();
        }

        if (input === "?") {
            setShowHelp((h) => !h);
        }
    });

    return { paused, showHelp, setShowHelp };
}
