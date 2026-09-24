import type { DbOrTx } from "../db/client.js";
import { auditLogs } from "../db/schema.js";

export interface Actor {
  type: "user" | "site" | "system";
  id: string | null;
}

export async function audit(
  db: DbOrTx,
  actor: Actor,
  action: string,
  entity?: string,
  entityId?: string,
  data?: Record<string, unknown>,
) {
  await db.insert(auditLogs).values({
    actorType: actor.type,
    actorId: actor.id,
    action,
    entity: entity ?? null,
    entityId: entityId ?? null,
    data: data ?? null,
  });
}
