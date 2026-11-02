import type { PriceHistory } from "./history";
import type {
    CategoryFilters,
    CategoryInfo,
    ListingPage,
    PickupPlace,
    ProductDetail,
    ProductSummary,
    Question,
    QuestionsResult,
    ReviewsResult,
    Suggestions,
} from "./types";

/** Markdown renderings shared by the CLI and the MCP server, so both doors print the same answer. */

const WHOLE_UNIT_CURRENCIES = new Set(["CZK", "HUF"]);

export function money(value: number | undefined, currency: string): string {
    if (value === undefined) {
        return "?";
    }

    return new Intl.NumberFormat("cs-CZ", {
        style: "currency",
        currency,
        maximumFractionDigits: WHOLE_UNIT_CURRENCIES.has(currency) ? 0 : 2,
    })
        .format(value)
        .replace(/ /g, " ");
}

export function priceText(item: ProductSummary): string {
    const now = money(item.price, item.currency);
    if (!item.originalPrice) {
        return now;
    }

    return `${now} (was ${money(item.originalPrice, item.currency)}, -${item.discountPercent ?? "?"} %)`;
}

export function ratingText(item: Pick<ProductSummary, "rating" | "ratingCount">): string {
    if (!item.rating) {
        return "no rating";
    }

    return `★${item.rating.toFixed(1)}${item.ratingCount ? ` (${item.ratingCount})` : ""}`;
}

function productLine(item: ProductSummary, index: number): string {
    const parts = [
        priceText(item),
        ratingText(item),
        item.availability ?? (item.inStock ? "in stock" : undefined),
        item.badge,
    ];
    return `${index + 1}. **${item.name}** \`${item.code}\` id ${item.id}\n   ${parts.filter(Boolean).join(" · ")}\n   ${item.url}`;
}

/** ", more exist (next: page 2, skip 20)": the continuation a caller passes back, empty when the listing ended. */
export function moreText(page: Pick<ListingPage, "hasMore" | "next">): string {
    if (page.next) {
        return `, more exist (next: page ${page.next.page}${page.next.skip ? `, skip ${page.next.skip}` : ""})`;
    }

    return page.hasMore ? ", more pages exist" : "";
}

export function listingMarkdown(title: string, page: ListingPage): string {
    // A filtered listing can spend its page budget with no match and still have pages left: keep the continuation.
    if (page.items.length === 0) {
        return `${title}: no products${moreText(page)}.`;
    }

    const head = `${title}: ${page.items.length} shown${page.total ? ` of ${page.total}` : ""}${moreText(page)}.`;
    return [head, "", ...page.items.map(productLine)].join("\n");
}

export function productMarkdown(p: ProductDetail): string {
    const lines = [
        `# ${p.name}`,
        "",
        `- Code \`${p.code}\`, id ${p.id}${p.ean ? `, EAN ${p.ean}` : ""}`,
        `- Price: ${priceText(p)}${p.badge ? ` · ${p.badge}` : ""}`,
        `- Rating: ${ratingText(p)}`,
        `- Availability: ${p.availability ?? "?"}${p.deliveryNote ? ` (${p.deliveryNote})` : ""}`,
    ];
    if (p.warranty) {
        lines.push(`- Warranty: ${p.warranty}`);
    }

    if (p.category) {
        lines.push(`- Category: ${p.category.name} (id ${p.category.id})`);
    }

    if (p.questionCount) {
        lines.push(`- Questions: ${p.questionCount}`);
    }

    if (p.sold) {
        lines.push(`- Sold: ${p.sold}`);
    }

    if (p.priceNote) {
        lines.push(`- Note: ${p.priceNote}`);
    }

    lines.push(`- ${p.url}`);
    if (p.spec) {
        lines.push("", p.spec);
    }

    if (p.params.length > 0) {
        lines.push("", "## Parameters");
        let group = "";
        for (const param of p.params) {
            if (param.group !== group) {
                group = param.group;
                lines.push("", `**${group}**`);
            }

            lines.push(`- ${param.name}: ${param.values.join(", ")}`);
        }
    }

    return lines.join("\n");
}

export function reviewsMarkdown(r: ReviewsResult, name?: string): string {
    const bars = r.distribution
        .map((count, i) => `${i + 1}★ ${count}`)
        .reverse()
        .join(" · ");
    const lines = [
        `# Reviews${name ? ` of ${name}` : ""} (product ${r.productId})`,
        "",
        `${r.total} reviews, average ${r.average?.toFixed(2) ?? "?"} of the fetched reviews. ${bars}`,
        "",
    ];
    for (const review of r.reviews) {
        const meta = [
            review.date,
            review.author,
            review.country,
            review.verified ? "verified purchase" : undefined,
            review.variant,
            review.translated ? "translated" : undefined,
            review.likes ? `${review.likes} found it useful` : undefined,
        ];
        lines.push(
            `### ${"★".repeat(Math.round(review.rating))}${"☆".repeat(5 - Math.round(review.rating))} ${meta.filter(Boolean).join(" · ")}`
        );
        if (review.text) {
            lines.push(review.text);
        }

        for (const pro of review.pros) {
            lines.push(`+ ${pro}`);
        }

        for (const con of review.cons) {
            lines.push(`- ${con}`);
        }

        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

function questionBlock(q: Question, depth: number): string[] {
    const indent = "  ".repeat(depth);
    const meta = [
        q.created?.slice(0, 10),
        q.author,
        q.upVotes || q.downVotes ? `+${q.upVotes}/-${q.downVotes}` : undefined,
    ];
    const lines = [
        `${indent}${depth === 0 ? "Q" : "A"}: ${q.text.replace(/\s*\n\s*/g, " ")}`,
        `${indent}   (${meta.filter(Boolean).join(" · ")})`,
    ];
    for (const answer of q.answers) {
        lines.push(...questionBlock(answer, depth + 1));
    }

    return lines;
}

export function questionsMarkdown(r: QuestionsResult): string {
    if (r.questions.length === 0) {
        return `Product ${r.productId} has no questions.`;
    }

    return [
        `# Questions (product ${r.productId}): ${r.questions.length} of ${r.total}`,
        "",
        ...r.questions.flatMap((q) => [...questionBlock(q, 0), ""]),
    ]
        .join("\n")
        .trimEnd();
}

export function compareMarkdown(products: ProductDetail[]): string {
    const rows: Array<[string, ...string[]]> = [
        ["Price", ...products.map(priceText)],
        ["Rating", ...products.map(ratingText)],
        ["Availability", ...products.map((p) => p.availability ?? "?")],
        ["Warranty", ...products.map((p) => p.warranty ?? "?")],
        ["Code", ...products.map((p) => p.code)],
    ];
    const names = [...new Set(products.flatMap((p) => p.params.map((x) => x.name)))];
    for (const name of names) {
        rows.push([name, ...products.map((p) => p.params.find((x) => x.name === name)?.values.join(", ") ?? "—")]);
    }

    const esc = (s: string) => s.replace(/\|/g, "\\|");
    return [
        `| | ${products.map((p) => esc(p.name)).join(" | ")} |`,
        `|---|${products.map(() => "---").join("|")}|`,
        ...rows.map((row) => `| ${row.map(esc).join(" | ")} |`),
    ].join("\n");
}

export function filtersMarkdown(f: CategoryFilters): string {
    const lines = [
        `# Filters of category ${f.categoryId}`,
        "",
        `Brands (brand id: name, count): ${f.brands.map((b) => `${b.id}: ${b.name} (${b.count ?? "?"})`).join(", ")}`,
        "",
    ];
    for (const facet of f.facets) {
        lines.push(
            `- **${facet.name}** (param ${facet.paramId}, ${facet.group}): ${facet.values.map((v) => `${v.id}=${v.name}${v.count ? ` (${v.count})` : ""}`).join(", ")}`
        );
    }

    return lines.join("\n");
}

export function categoryMarkdown(c: CategoryInfo): string {
    return [
        `# ${c.name ?? `Category ${c.id}`} (id ${c.id})`,
        c.breadcrumbs.length ? `Path: ${c.breadcrumbs.join(" › ")}` : "",
        c.url,
        "",
        ...c.children.map(
            (child) =>
                `- ${child.name}${child.id ? ` (id ${child.id})` : ""}${child.url && !child.id ? ` ${child.url}` : ""}`
        ),
    ]
        .filter((line, i) => line !== "" || i === 3)
        .join("\n");
}

export function suggestionsMarkdown(s: Suggestions): string {
    const section = (title: string, rows: string[]) =>
        rows.length ? [`**${title}**`, ...rows.map((r) => `- ${r}`), ""] : [];
    return [
        ...section("Phrases", s.phrases),
        ...section(
            "Products",
            s.products.map((p) => `${p.name}${p.id ? ` (id ${p.id})` : ""}`)
        ),
        ...section(
            "Categories",
            s.categories.map((c) => `${c.name}${c.id ? ` (id ${c.id})` : ""}`)
        ),
        ...section(
            "Brands",
            s.brands.map((b) => b.name)
        ),
    ]
        .join("\n")
        .trimEnd();
}

export function historyMarkdown(h: PriceHistory, currency: string): string {
    if (h.source === "none") {
        return `Hlídač shopů has no price history for ${h.name} (${h.url}).`;
    }

    const lines = [
        `# Price history of ${h.name}`,
        "",
        `- Now: ${money(h.currentPrice, currency)}`,
        h.lowest ? `- Lowest: ${money(h.lowest.price, currency)} on ${h.lowest.date}` : "",
        h.highest ? `- Highest: ${money(h.highest.price, currency)} on ${h.highest.date}` : "",
        h.lowest30Days !== undefined
            ? `- Lowest in the 30 days before the last change: ${money(h.lowest30Days, currency)}`
            : "",
        h.claimedDiscount !== undefined ? `- Discount Alza claims: ${h.claimedDiscount} %` : "",
        h.realDiscount !== undefined ? `- Real discount (Hlídač shopů): ${h.realDiscount} %` : "",
        `- ${h.points.length} price points, source ${h.source}`,
        "",
        "Last changes:",
        ...h.points
            .slice(-12)
            .map(
                (p) =>
                    `- ${p.date}: ${p.price === null ? "not sold" : money(p.price, currency)}${p.originalPrice ? ` (was ${money(p.originalPrice, currency)})` : ""}`
            ),
    ];
    return lines.filter((line) => line !== "").join("\n");
}

export function pickupMarkdown(center: { label?: string }, places: PickupPlace[]): string {
    return [
        `AlzaBoxes near ${center.label ?? "the point"}:`,
        ...places.map(
            (p, i) =>
                `${i + 1}. ${p.name}${p.address ? `, ${p.address}` : ""}${p.distanceKm !== undefined ? ` (${p.distanceKm} km)` : ""}`
        ),
    ].join("\n");
}
