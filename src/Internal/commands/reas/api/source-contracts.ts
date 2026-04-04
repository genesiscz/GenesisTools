export const SOURCE_CONTRACTS = {
    REAS_CATALOG: "reas-catalog",
    REAS_POINTERS: "reas-pointers-and-clusters",
    SREALITY_V2: "sreality-v2",
    SREALITY_V2_SALE: "sreality-v2-sale",
    SREALITY_V1_HISTOGRAM: "sreality-v1-histogram",
    SREALITY_V1_CLUSTERS: "sreality-v1-clusters",
    SREALITY_V1_GEOMETRIES: "sreality-v1-geometries",
    BEZREALITKY_GRAPHQL: "graphql:listAdverts",
    BEZREALITKY_GRAPHQL_SALE: "graphql:listAdverts:sale",
    EREALITY_HTML: "ereality-html",
    MF_CENOVA_MAPA: "mf-cenova-mapa",
} as const;

export type SourceContract = (typeof SOURCE_CONTRACTS)[keyof typeof SOURCE_CONTRACTS];
