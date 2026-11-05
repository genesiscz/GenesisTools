import type { AgentNewReceiptDto, LaunchAccountDto } from "@dd/contract";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useLaunchOptions, useStartAgent } from "@/features/launch/hooks";
import { filterRepos, headroomLine, suggestedAccount, TIER_LABELS } from "@/features/launch/queries";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/** How many repos the picker lists before the filter narrows it. */
const REPOS_SHOWN = 8;

function Chip({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID: string }) {
    const c = useThemeColors();

    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={onPress}
            className="rounded-full px-3 py-1.5"
            style={{
                backgroundColor: selected ? c.accentMuted : c.bgPanel,
                borderWidth: 1,
                borderColor: selected ? c.accentGlow : c.border,
            }}
        >
            <Text style={{ color: selected ? c.accent : c.textSecondary, fontFamily: "monospace" }}>{label}</Text>
        </Pressable>
    );
}

function AccountRow({ account, selected, onPress }: { account: LaunchAccountDto; selected: boolean; onPress: () => void }) {
    const c = useThemeColors();
    const tone = account.tier === "ready" ? c.accent : account.tier === "session-starved" ? c.warning : c.textMuted;

    return (
        <Pressable
            testID={`launch-account-${account.name}`}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={onPress}
            className="flex-row items-center gap-3 rounded-xl px-3 py-2.5"
            style={{ backgroundColor: selected ? c.accentMuted : c.bgPanel, borderWidth: 1, borderColor: selected ? c.accentGlow : c.border }}
        >
            <View className="flex-1 gap-0.5">
                <Text style={{ color: c.textPrimary, fontWeight: "600" }}>{account.name}</Text>
                <Text numberOfLines={1} style={{ color: c.textMuted, fontSize: 12 }}>
                    {headroomLine(account)}
                </Text>
            </View>
            <Text style={{ color: tone, fontFamily: "monospace", fontSize: 11 }}>{TIER_LABELS[account.tier]}</Text>
        </Pressable>
    );
}

/**
 * The New agent sheet (F21): pick the harness, the account (ranked by headroom from the Mac's cached usage readings,
 * the best usable one picked first), the repo and a first prompt, then start the session in a background cmux
 * workspace on the Mac (`tools cmux agents new`).
 */
export default function AgentNewScreen() {
    const c = useThemeColors();
    const options = useLaunchOptions();
    const [agentId, setAgentId] = useState<string | null>(null);
    const [accountName, setAccountName] = useState<string | null>(null);
    const [repo, setRepo] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [prompt, setPrompt] = useState("");
    const [receipt, setReceipt] = useState<AgentNewReceiptDto | null>(null);
    const [key, setKey] = useState(idempotencyKey);
    // Every answer is a known outcome, so the next tap is a new request: a refusal is not replayed, and a second
    // agent started from this sheet is not answered with the first one's receipt. A failed request gives no answer and
    // keeps the key, so its retry stays one request.
    const start = useStartAgent((answer) => {
        setReceipt(answer);
        setKey(idempotencyKey());
    });

    const agents = options.data?.agents ?? [];
    const agent = agents.find((entry) => entry.id === agentId) ?? agents[0];
    const repos = useMemo(() => filterRepos(options.data?.repos ?? [], filter), [options.data?.repos, filter]);

    useEffect(() => {
        setAccountName(suggestedAccount(agent)?.name ?? null);
    }, [agent]);

    const ready = Boolean(agent && accountName && repo) && !start.isPending;
    const submit = () => {
        if (!agent || !accountName || !repo) {
            return;
        }

        start.mutate({ agent: agent.id, account: accountName, repo, prompt: prompt.trim() || undefined, idempotencyKey: key });
    };

    if (options.isPending) {
        return (
            <View className="flex-1 items-center justify-center bg-dd-bg-base">
                <ActivityIndicator color={c.accent} />
            </View>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: "New agent" }} />
            <ScrollView
                testID="screen-agent-new"
                accessibilityLabel="screen-agent-new"
                className="flex-1 bg-dd-bg-base"
                contentInsetAdjustmentBehavior="automatic"
                keyboardShouldPersistTaps="handled"
                contentContainerClassName="gap-4 p-4"
            >
                {options.isError ? <Text style={{ color: c.danger }}>{String(options.error)}</Text> : null}
                <MockBadge />
                <View className="gap-2">
                    <SectionHeader title="Agent" />
                    <View className="flex-row flex-wrap gap-2">
                        {agents.map((entry) => (
                            <Chip
                                key={entry.id}
                                testID={`launch-agent-${entry.id}`}
                                label={entry.id}
                                selected={entry.id === agent?.id}
                                onPress={() => setAgentId(entry.id)}
                            />
                        ))}
                    </View>
                </View>
                <View className="gap-2">
                    <SectionHeader title="Account" />
                    {agent && agent.accounts.length > 0 ? (
                        agent.accounts.map((account) => (
                            <AccountRow
                                key={account.id}
                                account={account}
                                selected={account.name === accountName}
                                onPress={() => setAccountName(account.name)}
                            />
                        ))
                    ) : (
                        <Text style={{ color: c.textMuted }}>No enabled account for this agent.</Text>
                    )}
                </View>
                <View className="gap-2">
                    <SectionHeader title="Repo" />
                    <TextInput
                        testID="launch-repo-filter"
                        value={filter}
                        onChangeText={setFilter}
                        placeholder="Filter repos"
                        placeholderTextColor={c.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        className="rounded-xl px-3 py-2.5"
                        style={{ color: c.textPrimary, backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border }}
                    />
                    <View className="flex-row flex-wrap gap-2">
                        {repos.slice(0, REPOS_SHOWN).map((name) => (
                            <Chip key={name} testID={`launch-repo-${name}`} label={name} selected={name === repo} onPress={() => setRepo(name)} />
                        ))}
                    </View>
                </View>
                <View className="gap-2">
                    <SectionHeader title="First prompt" />
                    <TextInput
                        testID="launch-prompt"
                        value={prompt}
                        onChangeText={setPrompt}
                        placeholder="Optional: what the agent starts with"
                        placeholderTextColor={c.textMuted}
                        multiline
                        className="min-h-24 rounded-xl px-3 py-2.5"
                        style={{ color: c.textPrimary, backgroundColor: c.bgPanel, borderWidth: 1, borderColor: c.border, textAlignVertical: "top" }}
                    />
                </View>
                <Pressable
                    testID="launch-start"
                    accessibilityRole="button"
                    disabled={!ready}
                    onPress={submit}
                    className="items-center rounded-xl py-3"
                    style={{ backgroundColor: c.accent, opacity: ready ? 1 : 0.4 }}
                >
                    <Text style={{ color: c.bgBase, fontWeight: "700" }}>{start.isPending ? "Starting…" : "Start on the Mac"}</Text>
                </Pressable>
                {receipt ? (
                    <View testID="launch-receipt" className="gap-2">
                        <Text style={{ color: receipt.started ? c.accent : c.danger }}>
                            {receipt.started
                                ? `Started ${receipt.name ?? "the session"}${receipt.workspace ? ` in ${receipt.workspace}` : ""}.`
                                : `Not started: ${receipt.error ?? "unknown"}`}
                        </Text>
                        {receipt.started ? (
                            <Pressable accessibilityRole="button" onPress={() => router.back()}>
                                <Text style={{ color: c.accent }}>Back to the board</Text>
                            </Pressable>
                        ) : null}
                    </View>
                ) : null}
                {start.isError ? <Text style={{ color: c.danger }}>{String(start.error)}</Text> : null}
            </ScrollView>
        </>
    );
}
