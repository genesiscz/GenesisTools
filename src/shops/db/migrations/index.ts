import { migration001 } from "@app/shops/db/migrations/001-initial";
import { migration002 } from "@app/shops/db/migrations/002-descriptions";
import { migration003 } from "@app/shops/db/migrations/003-providers";
import { migration004 } from "@app/shops/db/migrations/004-auth";
import { migration005 } from "@app/shops/db/migrations/005-favorites-unique";
import type { Migration } from "@app/utils/database/migrations";

export const SHOPS_MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005];
