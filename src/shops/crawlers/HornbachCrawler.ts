import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class HornbachCrawler extends ShopCrawler {
    readonly strategy = "hornbach-html";
}
