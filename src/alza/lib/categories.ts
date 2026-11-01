import { z } from "zod";
import type { AlzaApi } from "./api";

/**
 * The category tree one level at a time. The reference reads the homepage navigation; the Android app's category
 * route answers id 0 with the top level as JSON (live 2026-11-01: 24 entries, campaigns such as Black Friday first),
 * so no HTML is parsed here.
 */

const categoryLevelSchema = z.object({
    cat_name: z.string().nullish(),
    data: z
        .array(
            z.object({
                id: z.number().nullish(),
                name: z.string().nullish(),
                url: z.string().nullish(),
                cat_type: z.string().nullish(),
                child_cnt: z.number().nullish(),
            })
        )
        .nullish(),
});

export interface CategoryNode {
    id: number;
    name: string;
    url?: string;
    /** CATEGORY for a real catalog branch; ACTION / MAILINGACTION for campaign pages. */
    type?: string;
    childCount?: number;
}

export interface CategoryLevel {
    parentId: number;
    parentName?: string;
    categories: CategoryNode[];
}

export async function listCategories(api: AlzaApi, parentId?: number): Promise<CategoryLevel> {
    const id = parentId ?? 0;
    const answer = await api.json(categoryLevelSchema, `/services/restservice.svc/v1/category/${id}?T=CATEGORY&P=0`);
    return {
        parentId: id,
        parentName: id === 0 ? undefined : (answer.cat_name ?? undefined),
        categories: (answer.data ?? []).flatMap((c) =>
            c.id && c.name
                ? [
                      {
                          id: c.id,
                          name: c.name,
                          url: c.url ?? undefined,
                          type: c.cat_type ?? undefined,
                          childCount: c.child_cnt ?? undefined,
                      },
                  ]
                : []
        ),
    };
}

export function categoriesMarkdown(level: CategoryLevel): string {
    const title =
        level.parentId === 0 ? "Top-level categories" : `Subcategories of ${level.parentName ?? level.parentId}`;
    if (level.categories.length === 0) {
        return `${title}: none.`;
    }

    return [
        `**${title}**`,
        ...level.categories.map(
            (c) =>
                `- ${c.name} \`${c.id}\`${c.childCount ? ` (${c.childCount} sub)` : ""}${c.type && c.type !== "CATEGORY" ? ` · ${c.type.toLowerCase()}` : ""}`
        ),
    ].join("\n");
}
