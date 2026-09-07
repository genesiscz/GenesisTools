import { useInput } from "ink";
import { useState } from "react";
import type { TabDefinition } from "../types";
import { isModalOpen } from "./input-scope";

/** The tab list is injected: `tools claude usage` adds Sessions, the others do not. */
export function useTabNavigation(tabs: TabDefinition[], defaultTab: number = 0) {
    // `defaultTab` is a PERSISTED index: a config written when the dashboard had
    // five tabs can point past the end, and tabs[activeIndex].id would throw.
    const [activeIndex, setActiveIndex] = useState(() =>
        Math.min(Math.max(0, Math.trunc(defaultTab) || 0), tabs.length - 1)
    );

    useInput((input, key) => {
        // A modal (Sessions action menu) owns digits/arrows while open —
        // switching tabs here would unmount the view mid-action.
        if (isModalOpen()) {
            return;
        }

        if (key.leftArrow) {
            setActiveIndex((i) => (i > 0 ? i - 1 : tabs.length - 1));
        }

        if (key.rightArrow) {
            setActiveIndex((i) => (i < tabs.length - 1 ? i + 1 : 0));
        }

        const num = parseInt(input, 10);

        if (num >= 1 && num <= tabs.length) {
            setActiveIndex(num - 1);
        }
    });

    return {
        activeTab: tabs[Math.min(activeIndex, tabs.length - 1)].id,
        activeIndex,
        tabs,
        setActiveIndex,
    };
}
