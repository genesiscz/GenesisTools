import { useInput } from "ink";
import { useState } from "react";
import { TABS, type TabId } from "../types";
import { isModalOpen } from "./input-scope";

export function useTabNavigation(defaultTab: number = 0) {
    // `defaultTab` is a PERSISTED index: a config written when the dashboard had
    // five tabs can point past the end, and TABS[activeIndex].id would throw.
    const [activeIndex, setActiveIndex] = useState(() =>
        Math.min(Math.max(0, Math.trunc(defaultTab) || 0), TABS.length - 1)
    );

    useInput((input, key) => {
        // A modal (Sessions action menu) owns digits/arrows while open —
        // switching tabs here would unmount the view mid-action.
        if (isModalOpen()) {
            return;
        }

        if (key.leftArrow) {
            setActiveIndex((i) => (i > 0 ? i - 1 : TABS.length - 1));
        }

        if (key.rightArrow) {
            setActiveIndex((i) => (i < TABS.length - 1 ? i + 1 : 0));
        }

        const num = parseInt(input, 10);

        if (num >= 1 && num <= TABS.length) {
            setActiveIndex(num - 1);
        }
    });

    return {
        activeTab: TABS[activeIndex].id as TabId,
        activeIndex,
        tabs: TABS,
        setActiveIndex,
    };
}
