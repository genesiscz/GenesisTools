import { z } from "zod";

/**
 * The fields this tool reads from Alza's Android-app routes. Unknown fields are stripped; every field Alza has been
 * seen to omit or null is optional, so a missing value degrades one column instead of failing the call.
 * Route inventory: lukabudik/alza-mcp-community docs/mobile-endpoint-coverage.md (MIT).
 */

const optStr = z.string().nullish();
const optNum = z.number().nullish();
const optBool = z.boolean().nullish();

const priceInfoV2 = z
    .object({
        priceNoCurrency: optNum,
        comparePrice: optStr,
        headerText: optStr,
    })
    .nullish();

export const commodityCardSchema = z.object({
    id: z.number(),
    code: z.string(),
    name: z.string(),
    url: optStr,
    spec: optStr,
    img: optStr,
    price: optStr,
    cprice: optStr,
    priceNoCurrency: optNum,
    avail: optStr,
    rating: optNum,
    ratingCount: optNum,
    can_buy: optBool,
    is_action: optBool,
    action_name: optStr,
    priceInfoV2,
});
export type CommodityCard = z.infer<typeof commodityCardSchema>;

export const searchResponseSchema = z.object({
    totalUnfiltered: optNum,
    display_cnt: optNum,
    data2: z.array(commodityCardSchema).nullish(),
    sorts: z.array(z.object({ sort: z.number(), description: z.string() })).nullish(),
});

const paramValue = z.object({ desc: z.string().nullish() });

export const productDetailSchema = commodityCardSchema.extend({
    gaPrice: optNum,
    cpriceNoCurrency: optNum,
    catalog_number: optStr,
    producerId: optNum,
    warranty: optStr,
    discussionPostCount: optNum,
    sales: optNum,
    avail_postfix: optStr,
    is_in_stock: optBool,
    gaCategory: optStr,
    descriptionBeforeDiscount: optStr,
    imgs: z.array(z.object({ big_url: optStr, origUrl: optStr, url: optStr })).nullish(),
    seo_categories: z.array(z.object({ id: z.number(), name: z.string(), catType: optStr })).nullish(),
    parameterGroups: z
        .array(
            z.object({
                name: z.string(),
                params: z.array(z.object({ name: z.string(), values: z.array(paramValue).nullish() })).nullish(),
            })
        )
        .nullish(),
});
export type ProductDetailRaw = z.infer<typeof productDetailSchema>;

export const productResponseSchema = z.object({ data: productDetailSchema.nullish(), err: optNum, msg: optStr });

export const alternativesResponseSchema = z.object({ data: z.array(commodityCardSchema).nullish(), total: optNum });

export const reviewItemSchema = z.object({
    rating: z.number(),
    likeCount: optNum,
    description: optStr,
    positives: z.array(z.string()).nullish(),
    negatives: z.array(z.string()).nullish(),
    name: optStr,
    verifiedPurchase: optBool,
    reviewDetail: optStr,
    isTranslated: optBool,
    flagUrl: optStr,
    images: z.array(z.unknown()).nullish(),
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const reviewsResponseSchema = z.object({
    items: z.array(reviewItemSchema).nullish(),
    paging: z.object({ offset: optNum, limit: optNum, size: optNum, next: z.unknown().nullish() }).nullish(),
});

/** A question or an answer. `userEmail` exists upstream and is deliberately not read. */
export const discussionPostSchema = z.object({
    id: z.number(),
    text: optStr,
    created: optNum,
    upVotes: optNum,
    downVotes: optNum,
    children_cnt: optNum,
    postType: optNum,
    user: z.union([z.string(), z.object({ name: optStr })]).nullish(),
});
export type DiscussionPostRaw = z.infer<typeof discussionPostSchema>;

export const discussionResponseSchema = z.object({
    items: z.array(discussionPostSchema).nullish(),
    totalCnt: optNum,
    hasNext: optBool,
});

const facetValue = z.object({ v: z.number(), desc: z.string().nullish(), cnt: optNum });

export const facetsResponseSchema = z.object({
    params: z
        .array(
            z.object({
                groups: z
                    .array(
                        z.object({
                            name: z.string(),
                            params: z
                                .array(
                                    z.object({
                                        name: z.string(),
                                        tId: z.number(),
                                        renderType: optStr,
                                        values: z.array(facetValue).nullish(),
                                    })
                                )
                                .nullish(),
                        })
                    )
                    .nullish(),
            })
        )
        .nullish(),
    producers: z.array(facetValue).nullish(),
    prices: z.array(z.object({ k: z.number(), v: optStr })).nullish(),
});

const link = z.object({ webLink: optStr, href: optStr }).nullish();

export const categoryResponseSchema = z.object({
    cat_name: optStr,
    data: z.array(z.object({ id: optNum, name: optStr, self: link })).nullish(),
    breadcrumbs: z
        .array(z.object({ category: z.object({ name: optStr, meta: z.object({ href: optStr }).nullish() }).nullish() }))
        .nullish(),
});

const clickAction = z.object({ webLink: optStr, href: optStr, name: optStr }).nullish();

export const whisperResponseSchema = z.object({
    commodities: z.array(z.object({ imageUrl: optStr, clickAction })).nullish(),
    phrases: z.array(z.object({ clickAction })).nullish(),
    categories: z.array(z.object({ clickAction })).nullish(),
    producers: z.array(z.object({ clickAction })).nullish(),
});

export const placesResponseSchema = z.object({
    pickupPlaces: z
        .object({
            value: z
                .array(
                    z.object({
                        id: z.string(),
                        type: optNum,
                        typeText: optStr,
                        name: optStr,
                        title: optStr,
                        addressText: optStr,
                        gpsPosition: z.object({ latitude: z.number(), longitude: z.number() }).nullish(),
                    })
                )
                .nullish(),
        })
        .nullish(),
});
