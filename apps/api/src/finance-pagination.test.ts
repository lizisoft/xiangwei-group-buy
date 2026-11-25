import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { moneyCents } from "@hometown/domain";
import { MemoryStore, type CommerceStore } from "./modules/core/store.js";
import { MysqlStore } from "./modules/core/mysql-store.js";
import type { LedgerTransaction, Order, OrderRefund, PartialRefund } from "./modules/core/types.js";

const date = "2026-09-30T00:00:00.000Z";

async function checkRefundLedgerLookup(store: CommerceStore) {
  const add = (id: string, referenceId: string, eventType: LedgerTransaction["eventType"]) =>
    store.appendLedgerTransaction({
      id, referenceId, eventType, createdAt: date, lines: [],
      referenceType: eventType === "PARTIAL_REFUND_SUCCEEDED" ? "FULFILLMENT_EXCEPTION" : "ORDER",
    });
  await store.saveOrder({
    id: "o1", orderNo: "HT-45", userId: "buyer", campaignId: "campaign", serviceAreaId: "area",
    pickupPointId: "point", deliveryPlanId: "plan", status: "COMPLETED", totalCents: moneyCents(4500),
    items: [], createdAt: date, expiresAt: date, paidAt: date, pickedUpAt: date,
  });
  for (const [id, orderId] of [["r1", "o1"], ["r2", "o1"], ["r3", "o2"]] as const) {
    await store.savePartialRefund({ id, orderId, exceptionId: "shared-exception", createdAt: date } as PartialRefund);
    await add(id, id, "PARTIAL_REFUND_SUCCEEDED");
  }
  await add("p1", "o1", "PAYMENT_SUCCEEDED");
  await add("f2", "o2", "REFUND_SUCCEEDED");
  for (const referenceId of ["HT-45", "o1"]) {
    const first = await store.listFinanceLedgerPage({ referenceId, limit: 2 });
    expect(first.items.map(row => row.id)).toEqual(["r2", "r1"]);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBeTruthy();
    const last = await store.listFinanceLedgerPage({ referenceId, limit: 2, cursor: first.nextCursor! });
    expect(last.items.map(row => row.id)).toEqual(["p1"]);
    expect(last).toMatchObject({ total: 3, nextCursor: null });
  }
  for (const [referenceId, ids] of [
    ["r1", ["r1"]], ["shared-exception", ["r3", "r2", "r1"]],
    ["o2", ["r3", "f2"]], ["unknown", []],
  ] as const) {
    const result = await store.listFinanceLedgerPage({ referenceId, limit: 10 });
    expect(result.items.map(row => row.id)).toEqual(ids);
    expect(result.total).toBe(ids.length);
  }
}

describe("bounded finance history pages", () => {
  it("finds historical partial refunds through their original order before paginating", async () => {
    await checkRefundLedgerLookup(new MemoryStore(false));
  });

  const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
  it.skipIf(!databaseUrl)("matches the same ledger history in MySQL aggregate and entity modes", async () => {
    const db = `ledger_test_${randomUUID().replaceAll("-", "")}`;
    const conn = await mysql.createConnection({ uri: databaseUrl!, multipleStatements: true });
    await conn.query("CREATE DATABASE ??", [db]).catch(async (error: unknown) => {
      await conn.end();
      throw error;
    });
    const uri = new URL(databaseUrl!);
    uri.pathname = `/${db}`;
    const store = MysqlStore.create(uri.href);
    try {
      await conn.query("USE ??", [db]);
      for (const file of ["0001_community_baseline.sql", "0005_entity_store.sql"]) {
        await conn.query(await readFile(new URL(`../../../infra/mysql/migrations/${file}`, import.meta.url), "utf8"));
      }
      await checkRefundLedgerLookup(store);
      // This database belongs only to this test. Populate the second layout independently.
      await conn.query("UPDATE community_entity_store_state SET mode='ENTITY' WHERE id=1");
      await checkRefundLedgerLookup(store);
    } finally {
      await store.close();
      try { await conn.query("DROP DATABASE IF EXISTS ??", [db]); }
      finally { await conn.end(); }
    }
  }, 30_000);
  it("keeps full refunds before partial refunds for equal timestamps and preserves filtered totals across cursors", async () => {
    const store = new MemoryStore(false);
    await store.saveOrderRefund({ id: "full-1", orderId: "order-1", createdAt: date, status: "SUCCEEDED", amountCents: 100 } as OrderRefund);
    await store.savePartialRefund({ id: "partial-1", orderId: "order-1", createdAt: date, status: "FAILED", amountCents: 20 } as PartialRefund);
    await store.saveOrderRefund({ id: "full-2", orderId: "order-2", createdAt: "2026-09-29T00:00:00.000Z", status: "FAILED", amountCents: 200 } as OrderRefund);
    await store.saveOrder({ id: "order-1", orderNo: "GB-1001" } as Order);
    await store.saveOrderRefund({ id: "full-search", orderId: "order-3", providerRefundNo: "RF-1003", createdAt: "2026-09-28T00:00:00.000Z", status: "MANUAL_HOLD", amountCents: 50 } as OrderRefund);
    await store.saveOrder({ id: "order-3", orderNo: "GB-1003" } as Order);
    const first = await store.listFinanceRefundPage({ limit: 1 });
    expect(first.items.map(value => [value.id, value.refundType])).toEqual([["full-1", "FULL"]]);
    expect(first.total).toBe(4);
    const second = await store.listFinanceRefundPage({ limit: 1, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) });
    expect(second.items.map(value => [value.id, value.refundType])).toEqual([["partial-1", "PARTIAL"]]);
    expect(second.total).toBe(4);
    expect((await store.listFinanceRefundPage({ limit: 10, status: "FAILED", orderId: "order-1" })).items.map(value => value.id)).toEqual(["partial-1"]);
    expect((await store.listFinanceRefundPage({ limit: 10, reference: "GB-1001" })).items.map(value => value.id).sort()).toEqual(["full-1", "partial-1"]);
    expect((await store.listFinanceRefundPage({ limit: 10, reference: "GB-1003" })).items.map(value => value.id)).toEqual(["full-search"]);
    expect((await store.listFinanceRefundPage({ limit: 10, reference: "RF-1003" })).items.map(value => value.id)).toEqual(["full-search"]);
  });

  it("bounds ledger pages and filters by exact reference while keeping stable order", async () => {
    const store = new MemoryStore(false);
    const entry = (id: string, referenceId: string, createdAt: string) => ({
      id, referenceId, referenceType: "ORDER", eventType: `PAYMENT_SUCCEEDED_${id}`, createdAt, lines: [],
    }) as LedgerTransaction;
    await store.appendLedgerTransaction(entry("l-1", "order-1", date));
    await store.appendLedgerTransaction(entry("l-2", "order-1", "2026-09-29T00:00:00.000Z"));
    await store.appendLedgerTransaction(entry("l-3", "order-2", date));
    const first = await store.listFinanceLedgerPage({ limit: 1, referenceId: "order-1" });
    expect(first.items.map(value => value.id)).toEqual(["l-1"]);
    expect(first.total).toBe(2);
    const second = await store.listFinanceLedgerPage({ limit: 1, referenceId: "order-1", ...(first.nextCursor ? { cursor: first.nextCursor } : {}) });
    expect(second.items.map(value => value.id)).toEqual(["l-2"]);
    expect(second.total).toBe(2);
  });
});
