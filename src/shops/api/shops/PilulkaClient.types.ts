// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/pilulka-daily/main.js

export interface PilulkaProductLD {
    "@type": "Product";
    name: string;
    image?: string | string[];
    description?: string;
    category?: string;
    offers?: {
        // Schema.org Offer.price is "Number or Text" — JSON-LD often uses strings like "55.00".
        price: number | string;
        priceCurrency?: string;
        availability?: string;
    };
}
