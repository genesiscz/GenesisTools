import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class ItescoCrawler extends ShopCrawler {
    readonly strategy = "itesco-html";
}
