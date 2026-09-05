import { Box, Text } from "ink";
import { Fragment } from "react";
import type { TabDefinition } from "../types";

interface TabBarProps {
    tabs: TabDefinition[];
    activeIndex: number;
}

export function TabBar({ tabs, activeIndex }: TabBarProps) {
    return (
        <Box flexShrink={0}>
            <Text dimColor>{"← "}</Text>
            {tabs.map((tab, i) => (
                <Fragment key={tab.id}>
                    {i > 0 && <Text dimColor>{"  "}</Text>}
                    {i === activeIndex ? (
                        <Text bold color="cyan" inverse>
                            {` ${tab.label} `}
                        </Text>
                    ) : (
                        <Text dimColor>{` ${tab.label} `}</Text>
                    )}
                </Fragment>
            ))}
            <Text dimColor>{" →"}</Text>
        </Box>
    );
}
