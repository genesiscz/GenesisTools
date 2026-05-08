// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/pilulka-daily/main.js

export interface PilulkaProductLD {
    "@type": "Product" | string;
    name: string;
    image?: string | string[];
    description?: string;
    category?: string;
    offers?: {
        price: number;
        priceCurrency?: string;
        availability?: string;
    };
}
