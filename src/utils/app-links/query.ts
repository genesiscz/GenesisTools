/** A query, empty values left out. `keepSlash` leaves `/` readable, which a query value may hold. */
export function linkQuery(
    pairs: Array<readonly [string, string | undefined]>,
    { keepSlash }: { keepSlash: boolean }
): string {
    const items = pairs.flatMap(([key, value]) => {
        if (value === undefined || value === "") {
            return [];
        }

        const encoded = encodeURIComponent(value);

        return [`${key}=${keepSlash ? encoded.replace(/%2F/g, "/") : encoded}`];
    });

    return items.length > 0 ? `?${items.join("&")}` : "";
}
