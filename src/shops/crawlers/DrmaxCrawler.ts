import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class DrmaxCrawler extends ShopCrawler {
    readonly strategy = "drmax-html";
}
