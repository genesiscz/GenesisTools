import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import type { InputMode } from "../../shared/WatchSession";

interface InputBarProps {
    mode: InputMode;
    contactName: string;
    onSubmit: (text: string) => void;
}

export function InputBar({ mode, contactName, onSubmit }: InputBarProps) {
    const [value, setValue] = useState("");

    const handleSubmit = (text: string) => {
        if (!text.trim()) {
            return;
        }

        onSubmit(text.trim());
        setValue("");
    };

    const modeIndicator = mode === "careful" ? " [CAREFUL]" : "";
    const prompt = `${contactName}${modeIndicator} > `;

    return (
        <Box borderStyle="single" borderColor="gray" paddingLeft={1}>
            <Text color={mode === "careful" ? "yellow" : "blue"}>{prompt}</Text>
            <TextInput
                value={value}
                onChange={setValue}
                onSubmit={handleSubmit}
                placeholder={mode === "careful" ? "Use /send <msg> to send..." : "Type a message or /help..."}
            />
        </Box>
    );
}
