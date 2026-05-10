import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class DmCrawler extends ShopCrawler {
    readonly strategy = "dm-rest";
}
