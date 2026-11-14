import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useDashboardClient } from "@/api/client-provider";
import { forecastQuery } from "@/features/accounts/queries";
import { useMinuteClock } from "@/lib/minute-clock";

/**
 * Component-facing accounts hooks (D32). The forecast polls only while its screen is focused, and `now` moves once a
 * minute there, so each reset countdown counts down between forecast reads.
 */
export function useAccountForecast() {
    const focused = useIsFocused();
    const options = forecastQuery(useDashboardClient());
    const forecast = useQuery({ ...options, refetchInterval: focused ? options.refetchInterval : false });
    const now = useMinuteClock(focused);

    return { forecast, now };
}
