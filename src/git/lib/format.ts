export function showItems<T>(items: T[], render: (item: T) => string): string {
    const n = items.length;

    if (n <= 6) {
        return items.map(render).join(", ");
    }

    if (n === 7) {
        return `${items.slice(0, 5).map(render).join(", ")}, … +2 more`;
    }

    return `${items.slice(0, 6).map(render).join(", ")}, … +${n - 6} more`;
}
