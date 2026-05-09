import type { Migration } from "@app/utils/database/migrations";
import { migration001 } from "./001-initial";
import { migration002 } from "./002-descriptions";

export const SHOPS_MIGRATIONS: Migration[] = [migration001, migration002];
