import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class BillaCrawler extends ShopCrawler {
    readonly strategy = "billa-rest";
}
