import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class KauflandCrawler extends ShopCrawler {
    readonly strategy = "kaufland-html";
}
