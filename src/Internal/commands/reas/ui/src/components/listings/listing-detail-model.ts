export interface PriceChange {
    amount: number;
    percent: number;
}

export interface PoiHighlight {
    category: string;
    name: string;
}

export interface ExternalResourceLink {
    label: string;
    url: string;
}

export interface ListingGalleryImage {
    full: string;
    preview: string;
}

export function extractFirstSeenAt(raw: unknown) {
    if (!isRecord(raw)) {
        return null;
    }

    return typeof raw.firstVisibleAt === "string" ? raw.firstVisibleAt : null;
}

export function getPriceChange({
    currentPrice,
    originalPrice,
}: {
    currentPrice: number;
    originalPrice: number | null;
}) {
    if (originalPrice === null || originalPrice <= 0 || originalPrice === currentPrice) {
        return null;
    }

    return {
        amount: currentPrice - originalPrice,
        percent: Number((((currentPrice - originalPrice) / originalPrice) * 100).toFixed(1)),
    } satisfies PriceChange;
}

export function extractPoiHighlights(poiData: Record<string, unknown> | null | undefined): PoiHighlight[] {
    if (!poiData) {
        return [];
    }

    const highlights: PoiHighlight[] = [];

    for (const [category, value] of Object.entries(poiData)) {
        const name = getPoiName(value);

        if (!name) {
            continue;
        }

        highlights.push({ category, name });
    }

    return highlights;
}

export function extractNemoreportLinks(value: unknown): ExternalResourceLink[] {
    const links: ExternalResourceLink[] = [];
    const seen = new Set<string>();
    walkUnknown({
        value,
        path: [],
        visit: ({ value: candidate, path }) => {
            if (
                typeof candidate !== "string" ||
                (!candidate.startsWith("http://") && !candidate.startsWith("https://"))
            ) {
                return;
            }

            if (seen.has(candidate)) {
                return;
            }

            seen.add(candidate);
            links.push({
                label: path.at(-1) ?? "link",
                url: candidate,
            });
        },
    });

    return links;
}

export function extractImageGallery(raw: unknown): ListingGalleryImage[] {
    if (!isRecord(raw)) {
        return [];
    }

    const imagesWithMetadata = raw.imagesWithMetadata;

    if (Array.isArray(imagesWithMetadata)) {
        return imagesWithMetadata
            .flatMap((entry) => {
                if (!isRecord(entry) || typeof entry.original !== "string") {
                    return [];
                }

                return [
                    {
                        full: entry.original,
                        preview: typeof entry.preview === "string" ? entry.preview : entry.original,
                        order: typeof entry.order === "number" ? entry.order : Number.MAX_SAFE_INTEGER,
                    },
                ];
            })
            .sort((left, right) => left.order - right.order)
            .map(({ full, preview }) => ({ full, preview }));
    }

    const images = raw.images;

    if (!Array.isArray(images)) {
        return [];
    }

    return images.flatMap((entry) => {
        if (typeof entry === "string") {
            return [{ full: entry, preview: entry }];
        }

        if (!isRecord(entry)) {
            return [];
        }

        const full = getImageUrl(entry, ["original", "url", "src"]);

        if (!full) {
            return [];
        }

        return [
            {
                full,
                preview: getImageUrl(entry, ["preview", "thumbnail", "thumb", "url", "src"]) ?? full,
            },
        ];
    });
}

export function mergeImageGallery({
    primary,
    secondary,
}: {
    primary: ListingGalleryImage[];
    secondary: ListingGalleryImage[];
}) {
    const merged: ListingGalleryImage[] = [];
    const seen = new Set<string>();

    for (const image of [...primary, ...secondary]) {
        if (seen.has(image.full)) {
            continue;
        }

        seen.add(image.full);
        merged.push(image);
    }

    return merged;
}

function getPoiName(value: unknown): string | null {
    if (!isRecord(value)) {
        return null;
    }

    if (typeof value.name === "string" && value.name.trim()) {
        return value.name;
    }

    const properties = value.properties;

    if (!isRecord(properties)) {
        return null;
    }

    const osmTags = properties.osm_tags;

    if (!isRecord(osmTags)) {
        return null;
    }

    return typeof osmTags.name === "string" && osmTags.name.trim() ? osmTags.name : null;
}

function getImageUrl(value: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        const candidate = value[key];

        if (typeof candidate === "string" && candidate.startsWith("http")) {
            return candidate;
        }
    }

    return null;
}

function walkUnknown({
    value,
    path,
    visit,
}: {
    value: unknown;
    path: string[];
    visit: (entry: { value: unknown; path: string[] }) => void;
}) {
    visit({ value, path });

    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            walkUnknown({ value: item, path: [...path, String(index)], visit });
        }

        return;
    }

    if (!isRecord(value)) {
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        walkUnknown({ value: child, path: [...path, key], visit });
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
