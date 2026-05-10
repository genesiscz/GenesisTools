import type { ShopApiClient } from "@app/shops/api/ShopApiClient";
import { AlbertCrawler } from "@app/shops/crawlers/AlbertCrawler";
import { AlzaCrawler } from "@app/shops/crawlers/AlzaCrawler";
import { BenuCrawler } from "@app/shops/crawlers/BenuCrawler";
import { BillaCrawler } from "@app/shops/crawlers/BillaCrawler";
import { DmCrawler } from "@app/shops/crawlers/DmCrawler";
import { DrmaxCrawler } from "@app/shops/crawlers/DrmaxCrawler";
import { HornbachCrawler } from "@app/shops/crawlers/HornbachCrawler";
import { ItescoCrawler } from "@app/shops/crawlers/ItescoCrawler";
import { KauflandCrawler } from "@app/shops/crawlers/KauflandCrawler";
import { KnihyDobrovskyCrawler } from "@app/shops/crawlers/KnihyDobrovskyCrawler";
import { KosikRestCrawler } from "@app/shops/crawlers/KosikRestCrawler";
import { LidlCrawler } from "@app/shops/crawlers/LidlCrawler";
import { MallCrawler } from "@app/shops/crawlers/MallCrawler";
import { MojaDmCrawler } from "@app/shops/crawlers/MojaDmCrawler";
import { MountfieldCrawler } from "@app/shops/crawlers/MountfieldCrawler";
import { NotinoCrawler } from "@app/shops/crawlers/NotinoCrawler";
import { PilulkaCrawler } from "@app/shops/crawlers/PilulkaCrawler";
import { RohlikRestCrawler } from "@app/shops/crawlers/RohlikRestCrawler";
import type { ShopCrawler } from "@app/shops/crawlers/ShopCrawler";
import { TetaCrawler } from "@app/shops/crawlers/TetaCrawler";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

export function createCrawlerForShop(client: ShopApiClient, db: ShopsDatabase): ShopCrawler {
    switch (client.shopOrigin) {
        case "rohlik.cz":
            return new RohlikRestCrawler(client, db);
        case "kosik.cz":
            return new KosikRestCrawler(client, db);
        case "kaufland.cz":
            return new KauflandCrawler(client, db);
        case "drmax.cz":
            return new DrmaxCrawler(client, db);
        case "benu.cz":
            return new BenuCrawler(client, db);
        case "itesco.cz":
            return new ItescoCrawler(client, db);
        case "dm.cz":
            return new DmCrawler(client, db);
        case "billa.cz":
            return new BillaCrawler(client, db);
        case "lidl.cz":
            return new LidlCrawler(client, db);
        case "tetadrogerie.cz":
            return new TetaCrawler(client, db);
        case "albert.cz":
            return new AlbertCrawler(client, db);
        case "alza.cz":
            return new AlzaCrawler(client, db);
        case "notino.cz":
            return new NotinoCrawler(client, db);
        case "mall.cz":
            return new MallCrawler(client, db);
        case "mountfield.cz":
            return new MountfieldCrawler(client, db);
        case "pilulka.cz":
            return new PilulkaCrawler(client, db);
        case "knihydobrovsky.cz":
            return new KnihyDobrovskyCrawler(client, db);
        case "hornbach.cz":
            return new HornbachCrawler(client, db);
        case "mojadm.sk":
            return new MojaDmCrawler(client, db);
        default:
            throw new Error(`no crawler registered for ${client.shopOrigin}`);
    }
}
