# Brand Alias Candidates from Plan 03 Crawlers

Notes for Plan 04 (BrandAliases seeding). Format:
`alias_normalized => canonical_brand`

Plan 03 phase-1 fixture observations (low-confidence; manual review needed):

## Rohlik (rohlik.cz)
- `filosophy => Filosophy` (Greek dessert vendor; products-batch.json fixture)

## Kosik (kosik.cz)
- (No fixture-derived aliases yet — listing-pekarna.json bakery items lack
  consistent `brand` field; many are Kosik own-label.)

## Kaufland (kaufland.cz)
- `lipánek => Lipánek` (synthetic fixture)
- `olma => Olma` (synthetic fixture)
- `pribiňáček => Pribiňáček` (synthetic fixture)

(These come from the shape of synthesized HTML fixtures because Kaufland's
edge blocks unauthenticated curl. Real fixtures for Kaufland will need
WebView-mediated capture, which Plan 09 covers.)

## Process notes
- Real-world brand aliases come into focus during Plan 04 matching, not Plan 03
  crawl. This file is a hand-off so Plan 04 doesn't have to rediscover what
  Plan 03 saw.
- Each shop client preserves the raw `brand` field from upstream API/HTML.
  Plan 04 normalizes via `removeDiacritics + lowercase + trim` and seeds
  `brand_aliases` via the BrandAliasesRepository (already in `src/shops/db/`).
