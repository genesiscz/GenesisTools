import type { Migration } from "@app/utils/database/migrations";
import { migration001 } from "./001-initial";

export const SHOPS_MIGRATIONS: Migration[] = [migration001];
