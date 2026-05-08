# Brand Aliases from Crawlers — Plan 04 Seed Source

Hand-off file for Plan 04's `seed-brand-aliases.ts`. Format per row:
`alias_string => canonical_brand`. Plan 04 normalizes via
`removeDiacritics + lowercase + trim` before INSERT-OR-IGNORE-ing into
`brand_aliases` with `source='seed'`.

`src/shops/db/BrandAliasesRepository.ts` is the runtime accessor; this file
is purely the seed-time content, not consumed at request time.

Canonical brands are kept FLAT (no shop namespace) when the brand is sold
across multiple shops. Private-label brands get a `<shop>:<slug>` namespace
so e.g. Tesco's "Tesco Finest" doesn't false-match a third-party product
that mentions Tesco in its name.

---

## Plan 03 — Phase 1 (Rohlík + Košík + Kaufland)

### Rohlík (rohlik.cz)

Rohlík exposes a `brand` field on every product in `/api/v1/products`. Brand
strings are author-cased; matching ignores case. Observed in fixtures
(`src/shops/api/shops/__fixtures__/rohlik/products-batch.json`):

- `Filosophy` => `filosophy` (Greek dessert vendor)
- `Koláčkova pekárna` => `kolackova-pekarna`
- `Ritter Sport` => `ritter-sport`

Live crawl on 2026-05-08 surfaced ~4 brand strings per 5-product sample.
Plan 04 will crawl deeper categories to enumerate the long tail.

### Košík (kosik.cz)

Košík exposes a `brand` field but bakery items lack it (own-label).
Observed in fixtures:

- (none high-confidence yet — listing-pekarna fixture is mostly own-label)

Plan 04 should re-crawl Košík FMCG categories where brand population is
higher (drogerie, mléčné výrobky, drinks).

### Kaufland (kaufland.cz)

Kaufland's HTML doesn't expose a separate brand field — brand is embedded
in the product name. Synthetic fixtures (real fixtures pending — edge blocks
curl with 403; Plan 09 will re-record via WebView):

- `Lipánek` => `lipanek` (own-label dairy)
- `Olma` => `olma`
- `Pribiňáček` => `pribinacek`

Recommended Plan 04 approach: parse name prefix as candidate brand for
Kaufland until a real `brand` selector is found.

---

## Plan 06 — Phase 3 contributions (Drmax + Benu + Itesco)

These come from impl-1's actor-source mining (rolled into this file by
prior coordination). Plan 06 itself hasn't shipped yet — these are
canonical hand-offs from upstream actor analysis.

### Drmax (drmax.cz)

Drmax sells third-party medications + cosmetics under known brands plus a
private label "Dr.Max":

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

Tesco's Czech storefront has a private label "Tesco" plus generic brands
(groceries):

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

---

## Shared-canonical handling

`paralen` and `ibalgin` appear in BOTH `drmax` and `benu` checklists — these
are canonical CZ pharmacy brands sold by everyone. Plan 04's seed must NOT
shop-namespace them; they get one canonical row each so the matcher merges
Drmax's "Paralen Grip 12 tbl" with Benu's "Paralen 500mg 24 tbl" by brand.

Shop-namespaced canonicals (`drmax:dr-max`, `benu:benu`, `itesco:tesco`) only
apply to private labels — those products literally don't exist outside the
issuing shop, so namespacing prevents cross-shop noise from "Tesco" string
matches in third-party brand names.

## Process notes

- Real-world brand aliases come into focus during Plan 04 matching, not Plan
  03 crawl. This file is a hand-off so Plan 04 doesn't have to rediscover
  what was learned during crawler implementation.
- Each shop client preserves the raw `brand` field from upstream API/HTML.
  Plan 04 normalizes and seeds via `BrandAliasesRepository`.
- File MOVED here on 2026-05-09 from `src/shops/lib/brand-alias-candidates.md`
  per team-lead direction (notes belong outside src/).
