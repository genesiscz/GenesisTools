import { NativeTabs } from "expo-router/unstable-native-tabs";

export default function TabsLayout() {
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
