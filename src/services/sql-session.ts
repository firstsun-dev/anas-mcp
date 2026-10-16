// Shared read-only PostgreSQL session plumbing for the Windmill-ingested analytics read models (Bing, Clarity).
import { Client } from "pg";

export interface SqlSession {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
/** Runs `fn` inside one consistent read-only snapshot. */
export type SessionRunner = <T>(fn: (session: SqlSession) => Promise<T>) => Promise<T>;

/**
 * Production runner: one short-lived pg connection per call through Hyperdrive, in a read-only snapshot.
 * `missingBinding` lets each domain surface its own safe `missing_configuration` error.
 */
export function createHyperdriveRunner(binding: Hyperdrive | undefined, missingBinding: () => Error): SessionRunner {
  return async (fn) => {
    if (!binding) throw missingBinding();
    const client = new Client({ connectionString: binding.connectionString, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      // REPEATABLE READ makes the run-metadata query and the row queries see the same canonical run.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}

/** Driver errors can embed hostnames/SQL; only the SQLSTATE is ever logged. */
export function sqlState(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "unknown";
}

export const toIso = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
};
export const toDay = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
};
