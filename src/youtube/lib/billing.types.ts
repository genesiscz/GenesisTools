export interface DiamondPack {
    id: "pack-small" | "pack-medium" | "pack-large";
    diamonds: number;
    usd: string;
}

export const DIAMOND_PACKS: DiamondPack[] = [
    { id: "pack-small", diamonds: 500, usd: "4.99" },
    { id: "pack-medium", diamonds: 2000, usd: "14.99" },
    { id: "pack-large", diamonds: 5000, usd: "29.99" },
];
