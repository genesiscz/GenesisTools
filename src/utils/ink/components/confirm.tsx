/**
 * Confirm — Tiered confirmation component
 *
 * Three tiers of confirmation:
 * - safe: Auto-confirms immediately, renders nothing
 * - moderate: Y/n prompt, supports autoConfirm
 * - destructive: Requires typing confirm text, cannot be bypassed
 */

import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";

export interface ConfirmProps {
    tier: "safe" | "moderate" | "destructive";
    message?: string;
    confirmText?: string;
    onConfirm: () => void;
    onCancel?: () => void;
    autoConfirm?: boolean;
    isProduction?: boolean;
}

// ── Safe tier ───────────────────────────────────────────────────────────────

function SafeConfirm({ onConfirm }: Pick<ConfirmProps, "onConfirm">) {
    useEffect(() => {
        onConfirm();
    }, [onConfirm]); // eslint-disable-line react-hooks/exhaustive-deps

    return null;
}

// ── Moderate tier ───────────────────────────────────────────────────────────

function ModerateConfirm({
    message,
    onConfirm,
    onCancel,
    autoConfirm,
}: Pick<ConfirmProps, "message" | "onConfirm" | "onCancel" | "autoConfirm">) {
    const [resolved, setResolved] = useState(false);

    useEffect(() => {
        if (autoConfirm && !resolved) {
            setResolved(true);
            onConfirm();
        }
    }, [autoConfirm, resolved, onConfirm]);

    useInput((input, key) => {
        if (resolved || autoConfirm) {
            return;
        }

        if (input.toLowerCase() === "y" || key.return) {
            setResolved(true);
            onConfirm();
        } else if (input.toLowerCase() === "n" || key.escape) {
            setResolved(true);
            onCancel?.();
        }
    });

    if (autoConfirm || resolved) {
        return null;
    }

    return (
        <Box flexDirection="column" gap={0}>
            {message && <Text>{message}</Text>}
            <Text>
                Continue? (
                <Text bold color="green">
                    Y
                </Text>
                /n)
            </Text>
        </Box>
    );
}

// ── Destructive tier ────────────────────────────────────────────────────────

function DestructiveConfirm({
    message,
    confirmText = "CONFIRM",
    onConfirm,
    onCancel,
}: Pick<ConfirmProps, "message" | "confirmText" | "onConfirm" | "onCancel">) {
    const [inputValue, setInputValue] = useState("");
    const [resolved, setResolved] = useState(false);

    const handleSubmit = (value: string) => {
        if (resolved) {
            return;
        }

        if (value === confirmText) {
            setResolved(true);
            onConfirm();
        }
    };

    useInput((_input, key) => {
        if (resolved) {
            return;
        }

        if (key.escape) {
            setResolved(true);
            onCancel?.();
        }
    });

    if (resolved) {
        return null;
    }

    return (
        <Box flexDirection="column" gap={0}>
            <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
                <Text bold color="red">
                    {"\u26A0"} WARNING
                </Text>
                {message && (
                    <Text color="red" wrap="wrap">
                        {message}
                    </Text>
                )}
            </Box>
            <Box marginTop={1}>
                <Text>
                    Type &apos;
                    <Text bold color="red">
                        {confirmText}
                    </Text>
                    &apos; to confirm:{" "}
                </Text>
                <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
            </Box>
        </Box>
    );
}

// ── Main component ──────────────────────────────────────────────────────────

export function Confirm({ tier, message, confirmText, onConfirm, onCancel, autoConfirm, isProduction }: ConfirmProps) {
    // Production always forces destructive tier
    const effectiveTier = isProduction ? "destructive" : tier;

    switch (effectiveTier) {
        case "safe":
            return <SafeConfirm onConfirm={onConfirm} />;

        case "moderate":
            return (
                <ModerateConfirm
                    message={message}
                    onConfirm={onConfirm}
                    onCancel={onCancel}
                    autoConfirm={autoConfirm}
                />
            );

        case "destructive":
            return (
                <DestructiveConfirm
                    message={message}
                    confirmText={confirmText}
                    onConfirm={onConfirm}
                    onCancel={onCancel}
                />
            );
    }
}
