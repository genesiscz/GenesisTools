import { Box, Text } from "ink";
import { Fragment } from "react";
import type { TabDefinition } from "../types";

interface TabBarProps {
    tabs: TabDefinition[];
    activeIndex: number;
}

export function TabBar({ tabs, activeIndex }: TabBarProps) {
    return (
        <Box>
            <Text dimColor>{"← "}</Text>
            {tabs.map((tab, i) => (
                <Fragment key={tab.id}>
                    {i > 0 && <Text dimColor>{" │ "}</Text>}
                    <Text bold={i === activeIndex} inverse={i === activeIndex}>
                        {` ${tab.label} `}
                    </Text>
                </Fragment>
            ))}
            <Text dimColor>{" →"}</Text>
        </Box>
    );
}
