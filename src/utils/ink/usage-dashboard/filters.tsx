import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { setModalOpen } from "./hooks/input-scope";
import { formatTimeRange, type UsageAccountRef } from "./types";

export interface FilterState {
    /** Plugin id, or null for "all providers". */
    provider: string | null;
    /** Account names, or null for "all accounts". */
    accounts: string[] | null;
    /** Minutes. */
    range: number;
}

/** `P` cycles: all → each provider → all. Pure, so the shell can test it. */
export function cycleProvider(current: string | null, providers: readonly string[]): string | null {
    if (providers.length === 0) {
        return null;
    }

    if (current === null) {
        return providers[0];
    }

    const index = providers.indexOf(current);

    if (index < 0 || index === providers.length - 1) {
        return null;
    }

    return providers[index + 1];
}

export function toggleAccount(current: string[] | null, name: string, all: readonly string[]): string[] | null {
    const selected = new Set(current ?? all);

    if (selected.has(name)) {
        selected.delete(name);
    } else {
        selected.add(name);
    }

    // Everything selected is the same as no filter, and keeps the CLI flag honest.
    if (selected.size === all.length) {
        return null;
    }

    return all.filter((n) => selected.has(n));
}

export interface FilterBarProps {
    filters: FilterState;
    providers: string[];
    accounts: UsageAccountRef[];
    accountPickerOpen: boolean;
    onCloseAccountPicker: () => void;
    onChange: (next: FilterState) => void;
}

/**
 * One line above the tab bar, plus the account checklist it opens (spec 7.4).
 * `p.multiselect` is a clack prompt and cannot run inside Ink, so the checklist is a
 * plain Ink list driven by the arrow keys and space.
 */
export function FilterBar({
    filters,
    providers,
    accounts,
    accountPickerOpen,
    onCloseAccountPicker,
    onChange,
}: FilterBarProps) {
    const names = useMemo(() => accounts.map((a) => a.name), [accounts]);
    const [cursor, setCursor] = useState(0);

    useInput(
        (input, key) => {
            if (key.escape || key.return) {
                setModalOpen(false);
                onCloseAccountPicker();
                return;
            }

            if (key.upArrow) {
                setCursor((c) => Math.max(0, c - 1));
            }

            if (key.downArrow) {
                setCursor((c) => Math.min(names.length - 1, c + 1));
            }

            if (input === " " && names[cursor]) {
                onChange({ ...filters, accounts: toggleAccount(filters.accounts, names[cursor], names) });
            }
        },
        { isActive: accountPickerOpen }
    );

    if (accountPickerOpen) {
        const selected = new Set(filters.accounts ?? names);

        return (
            <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
                <Text bold color="cyan">
                    {"Accounts — space toggles, Enter closes"}
                </Text>
                {names.map((name, i) => (
                    <Text key={name} inverse={i === cursor}>
                        {`${selected.has(name) ? "[x]" : "[ ]"} ${name}`}
                    </Text>
                ))}
                {names.length === 0 ? <Text dimColor>{"no accounts"}</Text> : null}
            </Box>
        );
    }

    const providerLabel = filters.provider ? providerAliasOf(filters.provider) : "all";
    const accountLabel = filters.accounts ? `${filters.accounts.length} selected` : "all";

    return (
        <Box flexShrink={0}>
            <Text dimColor>{"P "}</Text>
            <Text color="cyan">{providerLabel}</Text>
            <Text dimColor>{"   a "}</Text>
            <Text color="cyan">{accountLabel}</Text>
            <Text dimColor>{"   f "}</Text>
            <Text color="cyan">{formatTimeRange(filters.range)}</Text>
            {providers.length <= 1 ? <Text dimColor>{"   (one provider)"}</Text> : null}
        </Box>
    );
}
