// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/mountfield-daily/main.js

export interface MountfieldRawProduct {
    itemId: string;
    itemUrl: string;
    itemName: string;
    img?: string;
    currentPrice?: number;
    originalPrice?: number;
    discounted: boolean;
    category: string;
}
