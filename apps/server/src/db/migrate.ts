import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Folder `drizzle/` berada di root paket server, baik saat dijalankan dari src/ maupun dist/. */
export const migrationsFolder = path.resolve(here, "../../drizzle");

export async function runMigrations() {
  await migrate(db, { migrationsFolder });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log("Migrasi selesai");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
