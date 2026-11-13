import type { TimesheetFillReceiptDto } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useDashboardClient } from "@/api/client-provider";
import { fillWeek, localDay, timesheetKeys, weekQuery } from "@/features/timesheet/queries";

const systemNow = () => new Date();

/**
 * The phone's local day, read again when the screen gains focus and when the app returns to the foreground. A screen
 * left open across a week boundary then loads, and fills, the current week instead of the one it first showed.
 */
export function useLocalDay(now: () => Date = systemNow): string {
    const [day, setDay] = useState(() => localDay(now()));
    const refresh = useCallback(() => setDay(localDay(now())), [now]);

    useFocusEffect(refresh);

    useEffect(() => {
        const subscription = AppState.addEventListener("change", (next) => {
            if (next === "active") {
                refresh();
            }
        });

        return () => subscription.remove();
    }, [refresh]);

    return day;
}

export function useTimesheetWeek(date: string) {
    return useQuery(weekQuery(useDashboardClient(), date));
}

export function useFillWeek(date: string, onReceipt: (receipt: TimesheetFillReceiptDto) => void) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: { timesheetId: number; revision: string; idempotencyKey: string }) =>
            fillWeek(client, { ...input, date }),
        onSuccess: onReceipt,
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: timesheetKeys.week(date) });
        },
    });
}
