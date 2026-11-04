import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { briefQuery } from "@/features/brief/queries";

/** The stored morning brief; null before the Mac first built it. */
export function useMorningBrief() {
    return useQuery(briefQuery(useDashboardClient()));
}
