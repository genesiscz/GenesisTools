# HAR Discovery Findings: Sreality & REAS API Endpoints

Date: 2026-04-04
Source files: `www.sreality.cz.har` (14 entries, 420 KB) | `www.reas.cz.har` (17 entries, 53 KB)

---

## Sreality (www.sreality.cz)

### Endpoint Families

Sreality exposes three endpoint families: V1 REST (public), V2 REST (public), and Next.js SSR (server-side rendered pages with dehydrated React Query state).

---

### 1. V1 API (`https://www.sreality.cz/api/v1/...`)

#### 1a. `/estates/filter_page/histogram`

Price distribution histogram for a search query.

| Field | Value |
|---|---|
| Method | `GET` |
| Auth | None required (unauthenticated access works) |
| Base URL | `https://www.sreality.cz/api/v1/estates/filter_page/histogram` |

**Query params:**

| Param | Example | Notes |
|---|---|---|
| `category_type_cb` | `2` | 1=sale, 2=rental |
| `category_main_cb` | `1` | 1=byty (flats) |
| `category_sub_cb` | `3,2` | Disposition codes (comma-separated) |
| `locality_country_id` | `112` | Czech Republic = 112 |
| `locality_search_name` | `ulice Gebauerova, Ostrava` | Human-readable locality |
| `locality_entity_type` | `street` | Type: `street`, `city`, `district`, etc. |
| `locality_entity_id` | `110781` | Sreality entity ID |
| `locality_radius` | `1` or `10` | Radius in km |
| `price_m2` | `false` | Whether histogram is per-m2 |

**Response shape:**

```typescript
interface HistogramResponse {
    result: {
        histogram: Array<{
            advert_count: number;   // listings in this bucket
            price_from: number;     // bucket lower bound (CZK)
            price_to: number;       // bucket upper bound (CZK)
        }>;
    };
}
```

Buckets are evenly spaced (HAR shows ~67 CZK wide buckets for rental in Ostrava). Typically 80 buckets. Already implemented in `SrealityClient.fetchHistogram()`.

---

#### 1b. `/estates/search`

Count-only search (when `limit=0`). Returns total matching listings.

| Field | Value |
|---|---|
| Method | `GET` |
| Auth | None |

**Query params:** Same as histogram plus:

| Param | Example | Notes |
|---|---|---|
| `limit` | `0` | 0 = count only, no results |
| `offset` | `0` | Pagination offset |
| `top_timestamp_to` | `1775092004` | Unix timestamp for temporal cutoff |

**Response shape:**

```typescript
interface SearchCountResponse {
    meta_description: string;
    meta_title: string;
    pagination: {
        limit: number;
        offset: number;
        total: number;     // <-- the count
    };
    results: [];           // empty when limit=0
    search_title: string;
    status_code: 200;
    status_message: "OK";
}
```

**Implementation note:** The `top_timestamp_to` param lets you query "as of" a specific time, useful for historical comparison. Two calls were made: one without it (total=25 for radius=1) and one with it (total=188 for radius=10). Not currently used in the codebase.

---

#### 1c. `/estates/search/clusters`

Map clusters for viewport-based rendering.

| Field | Value |
|---|---|
| Method | `GET` |
| Auth | None |

**Additional query params (beyond base search params):**

| Param | Example | Notes |
|---|---|---|
| `lat_max` | `50.024505` | Viewport bounds |
| `lat_min` | `49.682735` | |
| `lon_max` | `18.748168` | |
| `lon_min` | `17.811584` | |
| `zoom` | `10` | Map zoom level |
| `lang` | `cs` | |
| `top_timestamp_to` | `1775092004` | |

**Response shape:**

```typescript
interface ClustersResponse {
    results: Array<{
        bounding_box: {
            lat_max: number;
            lat_min: number;
            lon_max: number;
            lon_min: number;
        };
        count: number;          // listings in cluster
        estates: [];            // empty at low zoom
        final_cluster: boolean; // true when zoomed enough to show individual pins
        geohashes: string[];    // geohash codes for the cluster area
        lat: number;            // cluster center
        lon: number;
    }>;
    status_code: 200;
    status_message: "OK";
}
```

Already implemented in `SrealityClient.fetchClusters()`.

---

#### 1d. `/localities/geometries`

GeoJSON-like geometry for a locality (country border, street path, etc.).

| Field | Value |
|---|---|
| Method | `GET` |
| Auth | None |

**Query params:**

| Param | Example | Notes |
|---|---|---|
| `entity_id` | `112` or `110781` | Country, district, street, etc. |
| `entity_type` | `country` or `street` | |
| `no_children` | `true` | Skip child geometries |

**Response shape:**

```typescript
interface GeometriesResponse {
    result: Array<{
        bounding_box: {
            lat_max: number; lat_min: number;
            lon_max: number; lon_min: number;
        };
        children: [];
        entity_id: number;
        entity_type: string;
        geometry: string[];         // encoded geometry strings
        geometry_type: string;      // "linestring", "polygon", etc.
    }>;
    status_code: 200;
    status_message: "OK";
}
```

Country geometry = 138 KB (large polygon). Street geometry = 337 bytes. Already implemented in `SrealityClient.fetchGeometries()`.

---

#### 1e. `/estates/favourites/ids` (auth required)

Returns user's favourited estate IDs.

| Field | Value |
|---|---|
| Method | `GET` |
| Auth | Required (returns 401 unauthenticated) |
| Response (401) | `{"error_details":{"is_sbr":false,"user_rus_id":null},"status_code":401,"status_message":"Unauthorized"}` |

Not relevant for our use case (we don't have Sreality user auth).

---

#### 1f. `/watchdogs` (auth required)

User's saved search alerts.

| Param | Example |
|---|---|
| `limit` | `10000` |
| `with_counts` | `false` |

Returns 401 unauthenticated. Not relevant.

---

#### 1g. `/estates/notes/ids` (auth required)

User's notes on estates. Returns 401. Not relevant.

---

### 2. Next.js SSR (`/_next/data/...`)

#### `/_next/data/{buildId}/cs/hledani/pronajem/byty.json`

Server-side rendered search results page with dehydrated React Query state.

| Field | Value |
|---|---|
| Method | `GET` |
| Response size | 277 KB |

**Query params (route-level):**

| Param | Example |
|---|---|
| `velikost` | `1+1,1+kk` |
| `region` | `ulice Gebauerova, Ostrava` |
| `region-id` | `110781` |
| `region-typ` | `street` |
| `vzdalenost` | `10` |

**Response shape (dehydrated):**

```typescript
interface NextDataResponse {
    pageProps: {
        dehydratedState: {
            queries: [
                { queryKey: ["timestamp"], state: { data: "2026-04-02T..." } },
                {
                    queryKey: ["estatesSearch", SearchParams],
                    state: {
                        data: {
                            pagination: {
                                limit: 22;
                                offset: 0;
                                total: number;
                                totalWithPromo: number;   // includes promoted
                            };
                            results: SrealitySSRListing[];
                            searchTitle: string;
                            metaTitle: string;
                            metaDescription: string;
                            brokerTip: BrokerTip | null;  // promoted broker
                            regionTip: RegionTip | null;
                            projectTip: ProjectTip | null;
                            warnings: unknown | null;
                        };
                    };
                }
            ];
        };
        total: number;
        timestamp: string;
        locale: "cs";
    };
}
```

**SSR Listing shape (richer than V2 API):**

```typescript
interface SrealitySSRListing {
    id: number;                        // hash_id
    name: string;                      // "Pronájem bytu 1+1 38 m²"
    categoryMainCb: { name: string; value: number };   // Byty=1
    categorySubCb: { name: string; value: number };    // 1+1=3, 1+kk=2
    categoryTypeCb: { name: string; value: number };   // Pronájem=2, Prodej=1
    priceCzk: number;                  // monthly rent or sale price
    priceCzkPerSqM: number;            // ** NEW: per-m2 price (not in V2) **
    priceSummaryCzk: number;
    priceSummaryUnitCb: { name: string; value: number };
    priceUnitCb: { name: string; value: number };
    discountShow: boolean;
    hasMatterport: boolean;
    hasVideo: boolean;
    watchdogBadge: "none" | string;
    premiseId: number;                 // real estate agency ID
    premiseLogo: string;
    premise: {
        seoName: string;
        wardSeoName: string;
        quarterSeoName: string;
        citySeoName: string;
    };
    locality: {
        city: string;
        citySeoName: string;
        cityPart: string | null;
        cityPartSeoName: string | null;
        country: string;
        countryId: number;
        district: string;              // "Ostrava-město"
        districtId: number;            // 65
        districtSeoName: string;
        entityType: string;            // "street", "address"
        geoHash: string;               // "u2ugntq2jb"
        houseNumber: string | null;
        inaccuracyType: string;        // "street", "gps"
        latitude: number;
        longitude: number;
        municipality: string | null;
        municipalityId: number;
        municipalitySeoName: string | null;
        quarter: string | null;        // "Ostrava-Jih"
        quarterId: number | null;
        region: string;                // "Moravskoslezský kraj"
        regionId: number;              // 12
        regionSeoName: string;
        street: string;
        streetId: number;
        streetNumber: string | null;
        streetSeoName: string;
        ward: string | null;
        wardId: number | null;
        wardSeoName: string | null;
        zip: string | null;
    };
    images: Array<{
        url: string;                   // "//d18-a.sdn.cz/d_18/..."
        restbType: number;
        order: number | null;
    }>;
}
```

**Key differences from V2 API (`/api/cs/v2/estates`):**

| Field | V2 API | SSR _next/data |
|---|---|---|
| `priceCzkPerSqM` | Not available | Available |
| `locality` | Single string | Full structured object with district, region, quarter, street, geoHash, lat/lng |
| `images` | Not included | Full image array |
| `premiseId` / `premise` | Not included | Agency info |
| `hasMatterport` / `hasVideo` | Not included | Available |
| `discountShow` | Not included | Available |
| `watchdogBadge` | Not included | Available |

**Implementation note:** The SSR endpoint returns dramatically richer data than the V2 API. The V2 API response (`_embedded.estates`) only gives: `hash_id`, `name`, `price`, `locality` (string), `gps`, `labels`, `seo`. The SSR path gives structured locality, per-m2 prices, images, and agency info. However, the SSR path depends on a build-specific `{buildId}` that changes on each deployment, making it fragile for automated use.

---

### 3. Request Headers (Sreality)

No auth required for API calls. Key headers:

```
accept: application/json, text/plain, */*
sec-fetch-mode: cors
sec-fetch-site: same-origin
user-agent: Mozilla/5.0 (Macintosh; ...) Chrome/146.0.0.0 Safari/537.36
```

Cookies are set (`sznlbr`, `cw_util`) but not required for API access.

---

### 4. Gaps in Current Codebase (Sreality)

| What's Missing | HAR Evidence | Priority |
|---|---|---|
| V1 `/estates/search` with `limit=0` for fast count | Entries 1, 3, 7 | Low (can use V2) |
| `top_timestamp_to` for temporal queries | Entry 7 | Medium (enables historical analysis) |
| SSR listing shape with `priceCzkPerSqM`, structured `locality`, images | Entry 4 | **High** (per-m2 price is critical for analysis) |
| `totalWithPromo` in pagination | Entry 4 | Low |
| Broker/region/project tips | Entry 4 | Low (marketing data) |

---

## REAS (www.reas.cz / catalog.reas.cz)

### Domain Architecture

REAS uses a microservice architecture with separate subdomains:

| Domain | Purpose |
|---|---|
| `catalog.reas.cz` | Core listing data (search, count, map clusters) |
| `notifier.reas.cz` | User notification system |
| `leader.reas.cz` | Subscription/watchdog management |
| `www.reas.cz` | Next.js frontend (SSR pages return empty `{}`) |

---

### 1. Catalog API (`https://catalog.reas.cz/catalog/...`)

#### 1a. `/listings/count`

Count matching sold listings.

| Field | Value |
|---|---|
| Method | `GET` |
| Auth | Cookie-based JWT (works without auth too based on `clientId`) |

**Query params:**

| Param | Example | Notes |
|---|---|---|
| `estateTypes` | `["flat"]` | JSON-encoded array |
| `constructionType` | `["panel"]` | JSON-encoded array |
| `heatingKind` | `["heat_network","electric","heat_pump"]` | **NEW: not in current codebase** |
| `soldDateRange` | `{"from":"...","to":"..."}` | JSON-encoded ISO date range |
| `bounds` | `{"southWestLatitude":...,"southWestLongitude":...,"northEastLatitude":...,"northEastLongitude":...}` | **NEW: geographic bounding box** |
| `linkedToTransfer` | `true` | Only cadastral-confirmed sales |
| `locality` | `{"districtId":3602}` | JSON-encoded |
| `clientId` | `6988cb437c5b9d2963280369` | Client tracking ID |

**Response shape:**

```typescript
interface CountResponse {
    success: boolean;
    data: { count: number };
}
```

Already implemented in `ReasClient.fetchSoldCount()`.

---

#### 1b. `/listings`

Full listing search with pagination.

| Field | Value |
|---|---|
| Method | `GET` |
| Auth | Cookie-based JWT (access-token + refresh-token) |

**Additional query params (beyond count):**

| Param | Example | Notes |
|---|---|---|
| `includeCount` | `true` | Include total count in response |
| `page` | `1` | Page number |
| `limit` | `10` | Results per page (HAR uses 10, codebase uses 20) |
| `sort` | `newest` | Sort order |

**Response shape:**

```typescript
interface ListingsResponse {
    success: boolean;
    data: Record<string, ReasListing>;  // NOTE: object with numeric keys, NOT array!
    count: number;
    page: number;
    limit: number;
    nextPage: number | null;
}
```

**IMPORTANT:** The HAR shows `data` as an `Record<string, ReasListing>` (object with keys "0", "1", ..., "9"), NOT an array. The current `ReasClient.types.ts` declares `data: ReasListing[]`. This may work because `Object.values()` or spread may coerce it, but it's technically wrong. The current code at `ReasClient.ts:119` does `body.data.push(...)` which would fail on an object. Need to verify if the API truly returns an object or if the HAR recording is an artifact.

**Listing shape:**

```typescript
interface ReasListing {
    _id: string;                     // MongoDB ObjectId ("68ed22c5571c224891f7e535")
    formattedAddress: string;        // "Brožíkova 610, Hradec Králové"
    formattedLocation: string;       // "Brožíkova 610/3, Hradec Králové - Nový Hradec Králové"
    imagesWithMetadata: Array<{
        original: string;            // GCS URL (full res)
        preview: string;             // GCS URL (thumbnail)
        order: number;
    }>;
    type: string;                    // "flat"
    subType: string;                 // "flat"
    soldPrice: number;               // actual sold price (from cadastre)
    price: number;                   // last asking price
    histogramPrice: number;          // price used for histogram buckets
    originalPrice: number;           // original listing price
    mapPointerId: string;            // "105737648010_unit_23424648-610-610"
    disposition: string;             // "1+kk", "4+kk", "3+1", etc.
    floorArea?: number;              // present in 4/10 listings (optional!)
    utilityArea: number;             // always present
    displayArea: number;             // always present (= preferred display area)
    cadastralAreaId: number;         // 647187
    municipalityId: number;          // 569810
    streetId: number;                // 126926
    cadastralAreaSlug: string;       // "novy-hradec-kralove"
    municipalitySlug: string;        // "hradec-kralove"
    streetSlug: string;              // "brozikova"
    soldAt: string;                  // ISO date: "2025-12-05T05:34:04.000Z"
    firstVisibleAt: string;          // ISO date: when listing first appeared
    point: {
        type: "Point";
        coordinates: [number, number]; // [lng, lat] (GeoJSON order!)
    };
    hot: boolean;                    // hot listing flag
    link: string;                    // full URL to REAS detail page
    mapPointerPublishedAt: string;   // ISO date
}
```

**Key observations:**
- `soldPrice` vs `price` vs `originalPrice` enables discount calculation (already used in codebase)
- `floorArea` is OPTIONAL (only 40% of listings have it) -- `displayArea` is the reliable field
- `firstVisibleAt` + `soldAt` enables time-on-market calculation
- `point.coordinates` is `[lng, lat]` (GeoJSON standard), NOT `[lat, lng]`
- Images come with both `original` and `preview` URLs on GCS

Already implemented in `ReasClient.fetchSoldListings()`.

---

#### 1c. `/listings/pointers-and-clusters` (NEW - not in codebase)

Map visualization data: individual pins + cluster aggregations.

| Field | Value |
|---|---|
| Method | `GET` |
| Auth | Same cookie-based JWT |

**Query params:** Same as `/listings/count` (including `bounds`, `heatingKind`).

**Response shape:**

```typescript
interface PointersAndClustersResponse {
    success: boolean;
    data: {
        pointers: Array<{
            _id: string;               // listing ID (MongoDB ObjectId)
            point: {
                type: "Point";
                coordinates: [number, number];  // [lng, lat]
            };
            geohash: string;           // "u2gm8r"
            estatesCount: number;      // usually 1 for individual pointers
        }>;
        clusterPointers: Array<{
            geohash: string;
            point: {
                type: "Point";
                coordinates: [number, number];
            };
            actualPoint: {
                type: "Point";
                coordinates: [number, number];
            };
            clusterBounds: [[number, number], [number, number]];  // [[lat_sw, lng_sw], [lat_ne, lng_ne]]
            amount: number;            // listings in cluster
        }>;
    };
}
```

**Implementation note:** This is REAS's equivalent of Sreality's `/estates/search/clusters`. Currently not implemented in the codebase. Useful for map-based visualization of sold properties.

---

### 2. Notifier API (`https://notifier.reas.cz/notifier/...`)

#### 2a. `/notifications/grouped`

User's grouped notifications (price changes, new matches, etc.).

| Param | Example |
|---|---|
| `sort` | `latest` |
| `limit` | `5` |
| `page` | `1` |

**Response shape:**

```typescript
interface GroupedNotificationsResponse {
    success: boolean;
    data: Array<unknown>;   // empty in HAR (user had no notifications)
    count: number;
    page: number;
    limit: number;
    nextPage: number | null;
}
```

---

#### 2b. `/notifications/grouped/count`

Unseen notification count.

| Param | Example |
|---|---|
| `notSeen` | `true` |

**Response shape:**

```typescript
interface NotificationCountResponse {
    success: boolean;
    data: { count: number };
}
```

**Implementation note:** Notification endpoints require user auth (JWT cookies). Low priority for our use case unless we want to integrate REAS watchdog alerts.

---

### 3. Leader API (`https://leader.reas.cz/leader/...`)

#### 3a. `/subscribes/estates-to-buy/`

User's saved search subscriptions (watchdogs).

| Param | Example | Notes |
|---|---|---|
| `estateType` | `flat` | Plain string (not JSON array) |
| `dispositions` | `["1+1","1+kk",...]` | JSON-encoded array |
| `districtId` | `3602` | Plain number |
| `clientId` | `6988cb437c5b9d2963280369` | |

**Response shape:**

```typescript
interface SubscribesResponse {
    success: boolean;
    data: {
        subscribes: Array<unknown>;  // empty in HAR
    };
}
```

Not currently needed. Could be used to sync REAS watchdogs with our watchlist feature.

---

### 4. Authentication (REAS)

REAS uses JWT cookie-based auth shared across all subdomains:

| Cookie | Type | Lifetime | Payload |
|---|---|---|---|
| `access-token` | HS256 JWT | 30 min (`exp - iat = 1800s`) | `type: "USER"`, `roles: ["PUBLIC_USER"]`, `email`, `fullName`, `sessionId`, `accountId` |
| `refresh-token` | HS256 JWT | ~1 year (`exp - iat ≈ 34.5M s`) | `type: "REFRESH_TOKEN"`, `sessionId` |

The `access-token` is short-lived (30 min). The `refresh-token` is long-lived (~1 year). The app likely has a silent refresh mechanism using the refresh token.

**For our codebase:** The current `ReasClient` does NOT send auth cookies. It relies on `clientId` in query params. The catalog API seems to work without auth for public data (sold listings are public). The `clientId` is hardcoded as `6988cb437c5b9d2963280369` in `ReasClient.ts:9`.

---

### 5. Query Params Not in Current Codebase (REAS)

| Param | Purpose | HAR Evidence | Priority |
|---|---|---|---|
| `heatingKind` | Filter by heating type: `heat_network`, `electric`, `heat_pump` | Entries 3-5, 10-11 | Medium (useful for property matching) |
| `bounds` | Geographic bounding box filter | All catalog entries | **High** (enables map-based search) |
| `includeCount` | Return total count with listings | Entry 11 | Low (already have `/count`) |
| `sort` | Sort order (`newest`) | Entry 11 | Low (codebase fetches all pages anyway) |

---

## Cross-Provider Summary

### Data Available by Provider

| Data Point | Sreality V1 | Sreality V2 | Sreality SSR | REAS Catalog |
|---|---|---|---|---|
| Listing count | `/search?limit=0` | `result_size` | `pagination.total` | `/count` |
| Price histogram | `/filter_page/histogram` | -- | -- | -- |
| Map clusters | `/search/clusters` | -- | -- | `/pointers-and-clusters` |
| Geo boundaries | `/localities/geometries` | -- | -- | -- |
| Listing search | `/search` | `/estates` | dehydrated query | `/listings` |
| Per-m2 price | -- | -- | `priceCzkPerSqM` | computed from `soldPrice/displayArea` |
| Structured location | -- | -- | `locality` object | `formattedAddress` + slug fields |
| Images | -- | -- | `images[]` | `imagesWithMetadata[]` |
| Sold price | -- | -- | -- | `soldPrice` |
| Original asking price | -- | -- | -- | `originalPrice` + `price` |
| Time on market | -- | -- | -- | `firstVisibleAt` to `soldAt` |
| Agency info | -- | -- | `premiseId` + `premise` | -- |
| Heating type filter | -- | -- | -- | `heatingKind` param |
| Geo bounds filter | -- | -- | -- | `bounds` param |

### Implementation Priorities

1. **HIGH: Add `bounds` and `heatingKind` params to `ReasClient`** -- the HAR shows these are actively used for more precise filtering. The `bounds` param is especially important for map-based search and for scoping results to a specific geographic area (rather than relying solely on `districtId`).

2. **HIGH: Add `pointers-and-clusters` endpoint to `ReasClient`** -- enables map visualization of sold properties, similar to existing Sreality clusters.

3. **MEDIUM: Verify `ListingsResponse.data` type** -- HAR shows it as `Record<string, ReasListing>` (object), but codebase declares `ReasListing[]`. May work due to JS coercion but should be typed correctly.

4. **MEDIUM: Add `top_timestamp_to` support to Sreality V1 search** -- enables historical/"as of" queries.

5. **LOW: Consider SSR endpoint for richer Sreality listing data** -- the `priceCzkPerSqM` and structured `locality` are valuable, but the build-specific URL makes this fragile.

6. **LOW: REAS notification/subscription APIs** -- only relevant if we want to sync REAS watchdogs.
