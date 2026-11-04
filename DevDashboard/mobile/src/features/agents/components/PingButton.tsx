import { type AgentBoardSession, ENDPOINTS, type PingWatchesDto } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useThemeColors } from "@/theme/colors";

const pingsKey = ["agents", "pings"] as const;

/**
 * "Ping me when done" (F15): the Mac watches this session and pushes once when its turn ends, with the agent's last
 * lines. The Mac does the watching, because the phone's stream stops in the background. A second tap stops it.
 */
export function PingButton({ session }: { session: AgentBoardSession }) {
    const c = useThemeColors();
    const client = useDashboardClient();
    const queryClient = useQueryClient();
    const pings = useQuery({ queryKey: pingsKey, queryFn: () => client.call(ENDPOINTS.gatewayPings, {}) });
    const watched = pings.data?.watches.some((watch) => watch.key === session.key) ?? false;
    const toggle = useMutation({
        mutationFn: (): Promise<PingWatchesDto> =>
            watched
                ? client.call(ENDPOINTS.pingUnwatch, { key: session.key }, { idempotencyKey: idempotencyKey() })
                : client.call(
                      ENDPOINTS.pingWatch,
                      { key: session.key, label: session.title ?? session.project ?? undefined },
                      { idempotencyKey: idempotencyKey() }
                  ),
        onSuccess: (next) => queryClient.setQueryData(pingsKey, next),
    });

    return (
        <Pressable
            testID="btn-ping-when-done"
            accessibilityRole="button"
            accessibilityLabel={watched ? "Stop the ping when this turn ends" : "Ping me when this turn ends"}
            accessibilityState={{ selected: watched, disabled: toggle.isPending }}
            disabled={toggle.isPending || pings.isPending}
            onPress={() => toggle.mutate()}
            className="items-center rounded-xl py-2.5"
            style={{ borderWidth: 1, borderColor: watched ? c.accent : c.border, opacity: toggle.isPending ? 0.6 : 1 }}
        >
            <Text style={{ color: watched ? c.accent : c.textPrimary, fontWeight: "600" }}>
                {toggle.isError ? `Not set: ${String(toggle.error)}` : watched ? "Pings when done ✓" : "Ping me when done"}
            </Text>
        </Pressable>
    );
}
