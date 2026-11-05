import type { PromptVariableDto } from "@dd/contract";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { useBoardSession } from "@/features/agents/hooks";
import { prepareQuery, promptsQuery, type SavedPromptRow } from "@/features/prompts/queries";
import { useThemeColors } from "@/theme/colors";
import { Empty } from "@/ui/Empty";

/** The words of each variable source. Exhaustive, so a new source fails to compile until it has a row. */
const SOURCE_WORDS: Record<PromptVariableDto["source"], string> = {
    given: "yours",
    session: "from the session",
    missing: "needed",
};

function PromptRow({ prompt, onPick }: { prompt: SavedPromptRow; onPick: () => void }) {
    const c = useThemeColors();

    return (
        <Pressable
            testID={`prompt-${prompt.name}`}
            accessibilityRole="button"
            accessibilityLabel={`Prompt ${prompt.name}`}
            onPress={onPick}
            className="gap-1 rounded-xl p-3"
            style={{ borderWidth: 1, borderColor: c.border, backgroundColor: c.bgPanel }}
        >
            <Text style={{ color: c.textPrimary, fontWeight: "700" }}>{prompt.name}</Text>
            {prompt.description ? (
                <Text numberOfLines={2} style={{ color: c.textSecondary, fontSize: 12 }}>
                    {prompt.description}
                </Text>
            ) : null}
            <Text style={{ color: c.textMuted, fontFamily: "monospace", fontSize: 11 }}>
                {[
                    prompt.variables.length > 0 ? prompt.variables.map((name) => `{{${name}}}`).join(" ") : null,
                    `used ${prompt.uses}×`,
                ]
                    .filter(Boolean)
                    .join(" · ")}
            </Text>
        </Pressable>
    );
}

/** One prompt prepared on the Mac for the session; the missing variables are typed here and prepared again. */
function Prepared({ name, sessionKey, session }: { name: string; sessionKey: string; session: string | null }) {
    const c = useThemeColors();
    const client = useDashboardClient();
    const [given, setGiven] = useState<Record<string, string>>({});
    const [draft, setDraft] = useState<Record<string, string>>({});
    const prepared = useQuery(prepareQuery(client, { name, session, vars: given }));

    if (prepared.isPending) {
        return <ActivityIndicator color={c.accent} />;
    }

    if (prepared.isError) {
        return <Empty testID="prompt-prepare-error" title="Could not prepare" hint={String(prepared.error)} />;
    }

    const ready = prepared.data.missing.length === 0;

    return (
        <ScrollView testID="prompt-prepared" contentContainerClassName="gap-3 p-4">
            {prepared.data.variables.map((variable) => (
                <View key={variable.name} className="gap-1">
                    <Text style={{ color: c.textSecondary, fontFamily: "monospace", fontSize: 12 }}>
                        {`{{${variable.name}}} · ${SOURCE_WORDS[variable.source]}`}
                    </Text>
                    <TextInput
                        testID={`prompt-var-${variable.name}`}
                        accessibilityLabel={`Value of ${variable.name}`}
                        defaultValue={variable.value ?? ""}
                        onChangeText={(value) => setDraft((current) => ({ ...current, [variable.name]: value }))}
                        placeholder={variable.source === "missing" ? "type a value" : undefined}
                        placeholderTextColor={c.textMuted}
                        className="rounded-xl px-3 py-2"
                        style={{
                            color: c.textPrimary,
                            borderWidth: 1,
                            borderColor: variable.source === "missing" ? c.warning : c.border,
                            backgroundColor: c.bgPanel,
                        }}
                    />
                </View>
            ))}
            <Text testID="prompt-text" selectable style={{ color: c.textPrimary, fontSize: 14 }}>
                {prepared.data.text}
            </Text>
            <View className="flex-row gap-2">
                {Object.keys(draft).length > 0 ? (
                    <Pressable
                        testID="btn-prompt-apply"
                        accessibilityRole="button"
                        onPress={() => setGiven((current) => ({ ...current, ...draft }))}
                        className="flex-1 items-center rounded-xl py-2"
                        style={{ borderWidth: 1, borderColor: c.accentGlow }}
                    >
                        <Text style={{ color: c.accent, fontWeight: "700" }}>Apply values</Text>
                    </Pressable>
                ) : null}
                <Pressable
                    testID="btn-prompt-use"
                    accessibilityRole="button"
                    accessibilityLabel="Use this prompt in the composer"
                    disabled={!ready}
                    onPress={() =>
                        router.navigate({ pathname: "/agent-session", params: { key: sessionKey, text: prepared.data.text } })
                    }
                    className="flex-1 items-center rounded-xl py-2"
                    style={{ backgroundColor: ready ? c.accent : c.accentMuted }}
                >
                    <Text style={{ color: ready ? c.bgBase : c.textMuted, fontWeight: "700" }}>
                        {ready ? "Use in composer" : `Needs ${prepared.data.missing.join(", ")}`}
                    </Text>
                </Pressable>
            </View>
        </ScrollView>
    );
}

/**
 * The Mac's saved prompts for one session (F23). A pick is prepared on the Mac for this session (each variable with
 * its value and source); a missing value is typed here; "Use in composer" puts the text in the session's steer
 * composer, which sends it through the session-send route. Siri needs the App Intent target of F4 stage two.
 */
export default function AgentPromptsScreen() {
    const c = useThemeColors();
    const { key } = useLocalSearchParams<{ key?: string }>();
    const session = useBoardSession(key ?? "");
    const prompts = useQuery(promptsQuery(useDashboardClient()));
    const [picked, setPicked] = useState<string | null>(null);

    return (
        <>
            <Stack.Screen options={{ title: picked ?? "Saved prompts" }} />
            <View testID="screen-agent-prompts" accessibilityLabel="screen-agent-prompts" className="flex-1 bg-dd-bg-base">
                {picked ? (
                    <Prepared name={picked} sessionKey={key ?? ""} session={session?.sessionId ?? null} />
                ) : prompts.isPending ? (
                    <ActivityIndicator color={c.accent} />
                ) : prompts.isError ? (
                    <Empty testID="prompts-error" title="Could not load prompts" hint={String(prompts.error)} />
                ) : (
                    <FlatList
                        testID="prompt-list"
                        data={prompts.data}
                        keyExtractor={(prompt) => prompt.name}
                        renderItem={({ item }) => <PromptRow prompt={item} onPick={() => setPicked(item.name)} />}
                        contentContainerClassName="gap-2 p-4"
                        ListEmptyComponent={<Empty testID="prompts-none" title="No saved prompts" hint="tools hub prompts add" />}
                    />
                )}
            </View>
        </>
    );
}
