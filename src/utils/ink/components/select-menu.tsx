/**
 * SelectMenu — Arrow-key select with description preview and badges
 *
 * Wraps ink-select-input with custom indicator, description preview,
 * and optional badge rendering.
 */

import { Box, Text } from "ink";
import SelectInput, { type Item } from "ink-select-input";
import { useMemo, useState } from "react";

export interface SelectItem {
    label: string;
    value: string;
    description?: string;
    badge?: { label: string; color: string; backgroundColor: string };
}

export interface SelectMenuProps {
    items: SelectItem[];
    onSelect: (value: string) => void;
    title?: string;
}

// ── Custom indicator ────────────────────────────────────────────────────────

function CustomIndicator({ isSelected }: { isSelected?: boolean }) {
    return (
        <Box marginRight={1}>
            <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "\u2192" : " "}</Text>
        </Box>
    );
}

// ── Custom item ─────────────────────────────────────────────────────────────

interface CustomItemProps {
    isSelected?: boolean;
    label: string;
}

function createItemComponent(itemsMap: Map<string, SelectItem>) {
    return function CustomItem({ isSelected, label }: CustomItemProps) {
        const item = itemsMap.get(label);
        const badge = item?.badge;

        return (
            <Box>
                <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
                    {label}
                </Text>
                {badge && (
                    <Text color={badge.color} backgroundColor={badge.backgroundColor}>
                        {" "}
                        {badge.label}{" "}
                    </Text>
                )}
            </Box>
        );
    };
}

// ── Component ───────────────────────────────────────────────────────────────

export function SelectMenu({ items, onSelect, title }: SelectMenuProps) {
    const [highlightedValue, setHighlightedValue] = useState<string | undefined>(items[0]?.value);

    // Build a label -> SelectItem map for the custom item renderer
    const itemsMap = useMemo(() => new Map(items.map((item) => [item.label, item])), [items]);

    // Convert to ink-select-input format
    const selectItems: Array<Item<string>> = useMemo(
        () =>
            items.map((item) => ({
                label: item.label,
                value: item.value,
            })),
        [items]
    );

    const handleSelect = (item: Item<string>) => {
        onSelect(item.value);
    };

    const handleHighlight = (item: Item<string>) => {
        setHighlightedValue(item.value);
    };

    // Find description for currently highlighted item
    const highlightedItem = items.find((item) => item.value === highlightedValue);
    const description = highlightedItem?.description;

    const ItemComponent = useMemo(() => createItemComponent(itemsMap), [itemsMap]);

    return (
        <Box flexDirection="column">
            {title && (
                <Box marginBottom={1}>
                    <Text bold>{title}</Text>
                </Box>
            )}
            <SelectInput
                items={selectItems}
                onSelect={handleSelect}
                onHighlight={handleHighlight}
                indicatorComponent={CustomIndicator}
                itemComponent={ItemComponent}
            />
            {description && (
                <Box marginTop={1} paddingLeft={3}>
                    <Text dimColor wrap="wrap">
                        {description}
                    </Text>
                </Box>
            )}
        </Box>
    );
}
