import type { TimesheetFillReceiptDto } from "@dd/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { fillWeek, timesheetKeys, weekQuery } from "@/features/timesheet/queries";

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
