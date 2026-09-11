import { create } from "zustand";

export type Tier = "lan" | "tailscale" | "cloudflared-self" | "managed";
export type ConnStatus = "disconnected" | "connecting" | "connected" | "error";

interface ConnectionState {
    tier: Tier;
    baseUrl: string | null;
    authHeader: string | null;
    status: ConnStatus;
    setEndpoint: (tier: Tier, baseUrl: string, authHeader: string | null) => void;
    setStatus: (status: ConnStatus) => void;
    reset: () => void;
}

export const useConnection = create<ConnectionState>((set) => ({
    tier: "lan",
    baseUrl: null,
    authHeader: null,
    status: "disconnected",
    setEndpoint: (tier, baseUrl, authHeader) => set({ tier, baseUrl, authHeader }),
    setStatus: (status) => set({ status }),
    reset: () => set({ baseUrl: null, authHeader: null, status: "disconnected" }),
}));
