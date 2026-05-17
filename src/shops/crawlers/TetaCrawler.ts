import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class TetaCrawler extends ShopCrawler {
    readonly strategy = "teta-rest";
}
