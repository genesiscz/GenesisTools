import { logger } from "@app/logger";
import type { BrandAliasesRepository } from "@app/shops/db/BrandAliasesRepository";
import { normalizeBrand } from "@app/shops/lib/normalize";

export class BrandResolver {
    private readonly log = logger.child({
        component: "BrandResolver",
        instance: Math.random().toString(36).slice(2, 8),
    });

    constructor(private readonly repo: BrandAliasesRepository) {}

    async resolve(rawBrand: string | null): Promise<string | null> {
        if (!rawBrand || rawBrand.trim().length === 0) {
            return null;
        }

        const verbatim = await this.repo.lookup(rawBrand);
        if (verbatim !== null) {
            this.log.debug({ rawBrand, canonical: verbatim, hit: "verbatim" }, "brand resolved");
            return verbatim;
        }

        const normalized = normalizeBrand(rawBrand);
        if (normalized === null) {
            return null;
        }

        const fromNormalized = await this.repo.lookup(normalized);
        if (fromNormalized !== null) {
            this.log.debug({ rawBrand, canonical: fromNormalized, hit: "normalized" }, "brand resolved");
            return fromNormalized;
        }

        this.log.debug({ rawBrand, canonical: normalized, hit: "fallback" }, "brand resolved via fallback");
        return normalized;
    }
}
