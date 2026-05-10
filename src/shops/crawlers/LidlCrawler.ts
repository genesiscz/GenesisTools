import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class LidlCrawler extends ShopCrawler {
    readonly strategy = "lidl-rest";
}
