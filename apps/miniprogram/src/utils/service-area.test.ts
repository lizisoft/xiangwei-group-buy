import { beforeEach, describe, expect, it, vi } from "vitest";

describe("service area selection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("clears the dependent pickup point but keeps saved purchases when its area is removed", async () => {
    const cart = { groups: [{ campaignId: "old-campaign" }, { campaignId: "other-campaign" }] };
    const checkout = { campaignId: "other-campaign" };
    const storage = new Map<string, unknown>([
      ["selectedServiceArea", { id: "removed-area", name: "旧服务区", regionCode: "130000" }],
      ["standardCart", cart],
      ["checkoutDraft", checkout],
      ["multiCheckoutDraft", cart],
    ]);
    const clearPickupPointSelection = vi.fn();
    vi.stubGlobal("wx", {
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
    });
    vi.doMock("./api", () => ({ api: { listServiceAreas: async () => [] } }));
    vi.doMock("./pickup-point", () => ({
      clearPickupPointSelection,
      readPickupPointSelection: () => ({ id: "old-point" }),
    }));

    const { loadServiceAreaContext } = await import("./service-area");
    const context = await loadServiceAreaContext();

    expect(context).toMatchObject({ areas: [], selected: null, selectionWasInvalidated: true });
    expect(storage.has("selectedServiceArea")).toBe(false);
    expect(storage.get("standardCart")).toEqual(cart);
    expect(storage.get("checkoutDraft")).toEqual(checkout);
    expect(storage.get("multiCheckoutDraft")).toEqual(cart);
    expect(clearPickupPointSelection).toHaveBeenCalledTimes(1);
  });

  it("does not clear a valid area's point or cart just because a campaign belongs to another area", async () => {
    const area = { id: "area-a", name: "服务区 A", regionCode: "130000", orderEnabled: true };
    const removeStorageSync = vi.fn();
    const clearPickupPointSelection = vi.fn();
    vi.stubGlobal("wx", { getStorageSync: () => area, removeStorageSync });
    vi.doMock("./api", () => ({ api: { listServiceAreas: async () => [area, { ...area, id: "area-b" }] } }));
    vi.doMock("./pickup-point", () => ({ clearPickupPointSelection, readPickupPointSelection: () => ({ id: "point-a" }) }));
    const { loadServiceAreaContext } = await import("./service-area");
    expect(await loadServiceAreaContext("area-b")).toMatchObject({ selected: null, selectionWasInvalidated: false });
    expect(clearPickupPointSelection).not.toHaveBeenCalled();
    expect(removeStorageSync).not.toHaveBeenCalled();
  });
});
