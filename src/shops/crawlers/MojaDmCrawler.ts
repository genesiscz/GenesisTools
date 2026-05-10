import { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";

export class MojaDmCrawler extends ShopCrawler {
    readonly strategy = "mojadm-rest";
}
