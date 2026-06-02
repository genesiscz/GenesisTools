import NetInfo from "@react-native-community/netinfo";
import { focusManager, onlineManager, QueryClient } from "@tanstack/react-query";
import { AppState, type AppStateStatus } from "react-native";

onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => setOnline(Boolean(state.isConnected)))
);

export function wireAppStateFocus(): () => void {
    const sub = AppState.addEventListener("change", (status: AppStateStatus) => {
        focusManager.setFocused(status === "active");
    });

    return () => sub.remove();
}

export const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 2, staleTime: 5_000 } },
});
