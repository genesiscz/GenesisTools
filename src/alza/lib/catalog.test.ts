import { describe, expect, test } from "bun:test";
import {
    cardToSummary,
    categoryListingPath,
    parseListingCards,
    parsePrice,
    parseReviewDetail,
    productIdFromRef,
    toReview,
} from "./catalog";

describe("parsePrice", () => {
    test("reads the storefront price formats", () => {
        expect(parsePrice("2 249,-")).toBe(2249);
        expect(parsePrice("1 859 Kč")).toBe(1859);
        expect(parsePrice("149,90 €")).toBe(149.9);
        expect(parsePrice("")).toBeUndefined();
        expect(parsePrice("zdarma")).toBeUndefined();
    });
});

describe("productIdFromRef", () => {
    test("takes an id or a URL and leaves a code to the search", () => {
        expect(productIdFromRef("9383715")).toBe(9383715);
        expect(productIdFromRef("https://www.alza.cz/auto/alcoforce-professional-2-0-d9383715.htm?o=1")).toBe(9383715);
        expect(productIdFromRef("https://www.alza.cz/x?dq=5089794")).toBe(5089794);
        expect(productIdFromRef("AUPR65708")).toBeUndefined();
    });
});

describe("categoryListingPath", () => {
    test("builds the numeric suffix Alza resolves", () => {
        expect(categoryListingPath({ categoryId: 18851284 }, 1)).toBe("/18851284.htm");
        expect(
            categoryListingPath({ categoryId: 18851284, brandId: 15529, params: [{ paramId: 15361, valueId: 239 }] }, 3)
        ).toBe("/18851284-v15529-par15361-239-p3.htm");
    });
});

describe("reviews", () => {
    test("parseReviewDetail splits the date and the variant", () => {
        expect(parseReviewDetail("Hodnoceno 5.09.2026, varianta Tester X")).toEqual({
            date: "2026-09-05",
            variant: "Tester X",
        });
        expect(parseReviewDetail(null)).toEqual({});
    });

    test("toReview keeps the text, the lists and the country", () => {
        const review = toReview({
            rating: 2,
            likeCount: 3,
            description: "  Shows zero after a beer. ",
            positives: ["design"],
            negatives: ["inaccurate"],
            name: "Alice, Brno",
            verifiedPurchase: true,
            reviewDetail: "Hodnoceno 10.06.2026, varianta Tester X",
            isTranslated: false,
            flagUrl: "https://cdn.example.com/images/flags/country/sk.svg",
            images: [],
        });
        expect(review).toMatchObject({
            rating: 2,
            text: "Shows zero after a beer.",
            country: "SK",
            date: "2026-06-10",
        });
        expect(review.cons).toEqual(["inaccurate"]);
    });
});

describe("listing cards", () => {
    test("cardToSummary derives the discount from the struck price", () => {
        const item = cardToSummary(
            {
                id: 1,
                code: "TST001",
                name: "Tester",
                url: "https://www.alza.cz/tester-d1.htm",
                price: "2 249,-",
                cprice: "2 799,-",
                priceNoCurrency: 2249,
                rating: 4.6,
                ratingCount: 98,
                can_buy: true,
                priceInfoV2: { headerText: "BLACK FRIDAY -19 %" },
            },
            "CZK",
            "https://www.alza.cz"
        );
        expect(item).toMatchObject({
            price: 2249,
            originalPrice: 2799,
            discountPercent: 19,
            badge: "BLACK FRIDAY -19 %",
        });
    });

    test("parseListingCards reads the server-rendered cards and the page links", () => {
        const html = `
            <div class="box browsingitem canBuy" data-code="TST001" data-id="11">
                <a class="name" href="/tester-d11.htm">Tester One</a>
                <div class="Description">Electrochemical sensor</div>
                <span class="ads-pb__header">BLACK FRIDAY -24 %</span>
                <span class="ads-pb__price-value">1 899,-</span>
                <span class="ads-pb__original-price">2 499,-</span>
                <span class="star-rating-block__value">4,6</span><span class="star-rating-block__count">1 234×</span>
                <span class="avlVal">Skladem</span>
            </div>
            <div class="box browsingitem" data-code="TST002" data-id="12"><a class="name" href="/t-d12.htm">Tester Two</a></div>
            <a href="/18851284-p2.htm">2</a><a href="/18851284-p3.htm">3</a>`;
        const parsed = parseListingCards(html, "CZK", "https://www.alza.cz");
        expect(parsed.pages).toEqual([2, 3]);
        expect(parsed.items).toHaveLength(2);
        expect(parsed.items[0]).toMatchObject({
            code: "TST001",
            url: "https://www.alza.cz/tester-d11.htm",
            price: 1899,
            originalPrice: 2499,
            discountPercent: 24,
            rating: 4.6,
            ratingCount: 1234,
            inStock: true,
        });
        expect(parsed.items[1].inStock).toBe(false);
    });
});
