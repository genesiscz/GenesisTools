import { Box, useApp, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import type { TelegramContactV2 } from "../../lib/types";
import type { WatchMessage, WatchSession } from "../shared/WatchSession";
import { ContactList } from "./components/ContactList";
import { InputBar } from "./components/InputBar";
import { MessageList } from "./components/MessageList";
import { StatusBar } from "./components/StatusBar";
import { SystemOutput, type SystemLine } from "./components/SystemOutput";

type View = "chat" | "contacts";

interface WatchInkAppProps {
    session: WatchSession;
}

export function WatchInkApp({ session }: WatchInkAppProps) {
    const { exit } = useApp();
    const [messages, setMessages] = useState<WatchMessage[]>(session.getMessages());
    const [view, setView] = useState<View>("chat");
    const [systemLines, setSystemLines] = useState<SystemLine[]>([]);

    useEffect(() => {
        const unsub = session.subscribe(() => {
            setMessages([...session.getMessages()]);
        });
        return unsub;
    }, [session]);

    useInput((_input, key) => {
        if (key.tab) {
            setView((v) => (v === "chat" ? "contacts" : "chat"));
        }
    });

    const clearSystemLines = useCallback(() => {
        setTimeout(() => setSystemLines([]), 10000);
    }, []);

    const handleSubmit = useCallback(
        async (text: string) => {
            setSystemLines([]);

            if (text.startsWith("/")) {
                const result = await session.handleSlashCommand(text);

                if (result.output === "__EXIT__") {
                    exit();
                    return;
                }

                if (result.handled && result.output) {
                    setSystemLines([{ text: result.output, type: "info" }]);
                    clearSystemLines();
                }

                return;
            }

            if (session.inputMode === "careful") {
                setSystemLines([{ text: "Careful mode: use /send <message> to send", type: "info" }]);
                clearSystemLines();
                return;
            }

            try {
                await session.sendMessage(text);
            } catch (err) {
                setSystemLines([
                    {
                        text: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
                        type: "error",
                    },
                ]);
            }
        },
        [session, exit, clearSystemLines],
    );

    const handleContactSelect = useCallback(
        async (contact: TelegramContactV2) => {
            await session.switchContact(contact);
            setView("chat");
        },
        [session],
    );

    if (view === "contacts") {
        return (
            <ContactList
                contacts={session.getContacts()}
                currentContactId={session.currentContact.userId}
                unreadCounts={session.getUnreadCounts()}
                onSelect={handleContactSelect}
                onBack={() => setView("chat")}
            />
        );
    }

    return (
        <Box flexDirection="column" height="100%">
            <StatusBar
                contact={session.currentContact}
                messageCount={messages.length}
                inputMode={session.inputMode}
            />
            <Box flexDirection="column" flexGrow={1}>
                <MessageList messages={messages} contactName={session.currentContact.displayName} />
            </Box>
            <SystemOutput lines={systemLines} />
            <InputBar
                mode={session.inputMode}
                contactName={session.currentContact.displayName}
                onSubmit={handleSubmit}
            />
        </Box>
    );
}
