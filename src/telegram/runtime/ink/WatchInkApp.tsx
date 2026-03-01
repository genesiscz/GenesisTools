import { useTerminalSize } from "@app/utils/ink/hooks/use-terminal-size";
import { Box, render, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";
import type { WatchRuntimeOptions } from "../light/WatchRuntime";
import { WatchSession } from "../shared/WatchSession";

interface WatchInkRootProps {
    session: WatchSession;
}

function WatchInkRoot({ session }: WatchInkRootProps) {
    useTerminalSize({ clearOnResize: true });
    const { exit } = useApp();
    const [input, setInput] = useState("");
    const [feedback, setFeedback] = useState("");
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        const unsubscribe = session.subscribe(() => {
            setRefreshKey((value) => value + 1);
        });

        return () => {
            unsubscribe();
        };
    }, [session]);

    const view = session.getViewModel();

    useInput((value, key) => {
        if (key.ctrl && value === "c") {
            exit();
            return;
        }

        if (key.tab) {
            session.cycleActiveChat(key.shift ? -1 : 1);
        }
    });

    const submitInput = (value: string) => {
        void (async () => {
            const result = await session.handleInput(value);
            setInput("");

            if (result.output) {
                setFeedback(result.output);
            }

            if (result.exit) {
                exit();
            }
        })();
    };

    return (
        <Box flexDirection="column" key={refreshKey}>
            <Text>
                Telegram Watch (Ink) | Tab/Shift+Tab switch chat | Enter sends | /help commands | Mode:{" "}
                {view.carefulMode ? "careful" : "normal"}
            </Text>

            <Box marginTop={1} flexDirection="row" flexWrap="wrap">
                {view.contacts.map((contact) => (
                    <Box key={contact.id} marginRight={2}>
                        <Text color={contact.isActive ? "cyan" : "white"}>
                            {contact.isActive ? ">" : " "} {contact.name}
                            {contact.unreadCount > 0 ? ` (${contact.unreadCount})` : ""}
                        </Text>
                    </Box>
                ))}
            </Box>

            <Box marginTop={1} flexDirection="column">
                {view.messages.slice(-25).map((message) => (
                    <Text key={`${message.id}-${message.timestampIso}`}>
                        {message.direction === "out" ? "You" : "Them"}: {message.text}
                    </Text>
                ))}
            </Box>

            {view.pendingSuggestions.length > 0 ? (
                <Box marginTop={1} flexDirection="column">
                    <Text color="yellow">Pending suggestions:</Text>
                    {view.pendingSuggestions.map((suggestion, index) => (
                        <Text key={`${index + 1}-${suggestion}`}>  {index + 1}. {suggestion}</Text>
                    ))}
                </Box>
            ) : null}

            {feedback ? (
                <Box marginTop={1}>
                    <Text color="green">{feedback}</Text>
                </Box>
            ) : null}

            <Box marginTop={1}>
                <Text color="cyan">Input: </Text>
                <TextInput value={input} onChange={setInput} onSubmit={submitInput} />
            </Box>
        </Box>
    );
}

export async function runWatchInkApp(options: WatchRuntimeOptions): Promise<void> {
    const session = new WatchSession({
        contacts: options.contacts,
        myName: options.myName,
        client: options.client,
        store: options.store,
        contextLengthOverride: options.contextLength,
    });

    await session.startListeners();

    const app = render(<WatchInkRoot session={session} />);
    await app.waitUntilExit();
}
