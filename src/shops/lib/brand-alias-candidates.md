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

## Plan 06 Phase 3 contributions (Drmax + Benu + Itesco)

Brand strings observed in actor sources for Phase 3 shops. Plan 04's
`seed-brand-aliases.ts` consumes these — INSERT-OR-IGNORE with `source='seed'`.

### Drmax (drmax.cz)
Drmax sells third-party medications + cosmetics under known brands plus a private label "Dr.Max":

- `Dr.Max` => `drmax:dr-max` (private label)
- `Paralen` => `paralen`
- `Ibalgin` => `ibalgin`
- `Panadol` => `panadol`
- `Nurofen` => `nurofen`
- `MaxiVita` => `maxivita`
- `MaxiCold` => `maxicold`
- `GS Vitamíny` => `gs-vitaminy`
- `Pharmacia` => `pharmacia`
- `Olynth` => `olynth`

### Benu (benu.cz)
Benu sells the same medication brands plus its own "Benu" line:

- `Benu` => `benu:benu` (private label)
- `Paralen` => `paralen` (canonical shared with Drmax — matcher merges them)
- `Ibalgin` => `ibalgin`
- `Aspirin` => `aspirin`
- `Voltaren` => `voltaren`
- `Strepsils` => `strepsils`
- `Bepanthen` => `bepanthen`
- `Vichy` => `vichy`
- `La Roche-Posay` / `La Roche Posay` => `la-roche-posay`
- `Bioderma` => `bioderma`
- `Avène` / `Avene` => `avene`

### Itesco (itesco.cz)
Tesco's Czech storefront has a private label "Tesco" plus generic brands (groceries):

- `Tesco` => `itesco:tesco` (private label, includes Finest, Value, Free From)
- `Tesco Finest` => `itesco:tesco-finest`
- `Tesco Value` => `itesco:tesco-value`
- `Tesco Free From` => `itesco:tesco-free-from`
- `Coca-Cola` => `coca-cola`
- `Pepsi` => `pepsi`
- `Nescafé` / `Nescafe` => `nescafe`
- `Milka` => `milka`
- `Lindt` => `lindt`
- `Nutella` => `nutella`
- `Kinder` => `kinder`
- `Ferrero` => `ferrero`
- `Heineken` => `heineken`
- `Plzeň` / `Pilsner Urquell` => `pilsner-urquell`

### Shared-canonical handling

`paralen` and `ibalgin` appear in BOTH `drmax` and `benu` checklists — these are
canonical CZ pharmacy brands sold by everyone. Plan 04's seed must NOT
shop-namespace them; they get one canonical row each so the matcher merges
Drmax's "Paralen Grip 12 tbl" with Benu's "Paralen 500mg 24 tbl" by brand.
Shop-namespaced canonicals (`drmax:dr-max`, `benu:benu`, `itesco:tesco`) only
apply to private labels — those products literally don't exist outside the
issuing shop, so namespacing prevents cross-shop noise from "Tesco" string
matches in third-party brand names.
