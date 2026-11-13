import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useOutboxDrain } from "@/features/agents/hooks";

export default function TabsLayout() {
    // The tabs stay mounted under every pushed screen while a Mac is connected, so the steer outbox drains here
    // rather than in the session screen that saved the draft.
    useOutboxDrain();

    return (
        <NativeTabs>
            <NativeTabs.Trigger name="index">
                <NativeTabs.Trigger.Icon sf="waveform.path.ecg" md="monitor_heart" />
                <NativeTabs.Trigger.Label>Pulse</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="terminals">
                <NativeTabs.Trigger.Icon sf="terminal" md="terminal" />
                <NativeTabs.Trigger.Label>Terminals</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="qa">
                <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" md="forum" />
                <NativeTabs.Trigger.Label>QA</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="obsidian">
                <NativeTabs.Trigger.Icon sf="book.closed" md="menu_book" />
                <NativeTabs.Trigger.Label>Obsidian</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="more">
                <NativeTabs.Trigger.Icon sf="ellipsis.circle" md="more_horiz" />
                <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
            </NativeTabs.Trigger>
        </NativeTabs>
    );
}
