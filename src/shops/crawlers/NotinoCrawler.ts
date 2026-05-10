import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class NotinoCrawler extends ShopCrawler {
    readonly strategy = "notino-html";
}
