import { SafeJSON } from "@app/utils/json";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { getMaster, getProduct } from "@app/shops/lib/product-api";

export interface ResourceDescriptor {
    uri: string;
    name: string;
    mimeType: "application/json";
}

export interface ResourceContent {
    uri: string;
    mimeType: "application/json";
    text: string;
}

export function listResources(): ResourceDescriptor[] {
    return [
        {
            uri: "shops://product/{shop}/{slug}",
            name: "Product detail (history + cross-shop matches)",
            mimeType: "application/json",
        },
        {
            uri: "shops://master/{id}",
            name: "Master product (canonical name + offers)",
            mimeType: "application/json",
        },
    ];
}

export async function readResource(uri: string, shopsDb: ShopsDatabase): Promise<ResourceContent> {
    const product = uri.match(/^shops:\/\/product\/([^/]+)\/([^/]+)$/);
    if (product) {
        const [, shop, slug] = product;
        const result = await getProduct({ shop, slug }, { shopsDb });
        return {
            uri,
            mimeType: "application/json",
            text: SafeJSON.stringify(result, null, 2),
        };
    }

    const master = uri.match(/^shops:\/\/master\/(\d+)$/);
    if (master) {
        const id = Number.parseInt(master[1], 10);
        const result = await getMaster({ id }, { shopsDb });
        return {
            uri,
            mimeType: "application/json",
            text: SafeJSON.stringify(result, null, 2),
        };
    }

    throw new Error(`Unsupported resource URI: ${uri}. Expected shops://product/<shop>/<slug> or shops://master/<id>`);
}
