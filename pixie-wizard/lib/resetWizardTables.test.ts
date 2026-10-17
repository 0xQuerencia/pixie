import { describe, expect, test } from "bun:test";

const { RESET_TABLES, counts, existingTables, snapshot } = await import("../scripts/program-reset-wizard.mjs");

describe("wizard reset optional-table discovery", () => {
  test("builds the table set before querying optional tables", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("information_schema.tables")) return { rows: [{ table_name: "hosted_programs" }] };
        if (sql.includes("hosted_programs")) return { rows: [{ count: 1 }] };
        throw new Error(`optional table queried: ${sql}`);
      },
    };
    const available = await existingTables(client);
    expect(available.has("hosted_programs")).toBe(true);
    expect(available.has("hosted_entitlements")).toBe(false);
    const result = await counts(client, "program-a", available);
    expect(result.hosted_programs).toBe(1);
    expect(result.wizard_entitlements).toBe(0);
    expect(queries.filter((query) => query.includes("hosted_entitlements")).length).toBe(0);
  });

  test("snapshot skips absent optional tables without an aborted transaction query", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes("hosted_programs")) return { rows: [{ id: "program-a" }] };
        throw new Error(`optional table queried: ${sql}`);
      },
    };
    const available = new Set(["hosted_programs"]);
    const archive = await snapshot(client, "program-a", "now", available);
    expect(archive.tables.hosted_programs).toEqual([{ id: "program-a" }]);
    expect(archive.tables.hosted_entitlements).toEqual([]);
    expect(RESET_TABLES).toContain("hosted_entitlements");
  });
});
