import { beforeEach, describe, expect, it, vi } from "vitest";

type PageDefinition = {
  data: Record<string, unknown>;
  setData: (patch: Record<string, unknown>) => void;
  openOrders: (event: { currentTarget: { dataset: { filter?: string } } }) => void;
  loadArea: () => Promise<void>;
  loadSummary: () => Promise<void>;
  logout: () => Promise<void>;
  openPickupLocation: () => void;
  callPickupPoint: () => void;
};

type OrdersPageDefinition = {
  data: Record<string, unknown>;
  setData: (patch: Record<string, unknown>) => void;
  onShow: () => Promise<void>;
  loadMore: () => Promise<void>;
};

describe("profile page protected entry behavior", () => {
  const storage = new Map<string, unknown>();

  beforeEach(() => {
    storage.clear();
    vi.resetModules();
    vi.stubGlobal("getApp", () => ({
      globalData: {
        apiBaseUrl: "http://127.0.0.1:3100",
        authMode: "demo",
        demoLoginEnabled: true,
        accessToken: null,
        subscriptionTemplates: [],
      },
    }));
  });

  async function loadPage(options: { areaError?: boolean } = {}) {
    const navigateTo = vi.fn(() => Promise.resolve());
    const switchTab = vi.fn(() => Promise.resolve());
    const request = vi.fn();
    const openLocation = vi.fn();
    const makePhoneCall = vi.fn();
    vi.stubGlobal("wx", {
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      navigateTo,
      navigateBack: vi.fn(() => Promise.resolve()),
      redirectTo: vi.fn(() => Promise.resolve()),
      switchTab,
      showToast: vi.fn(() => Promise.resolve()),
      openLocation,
      makePhoneCall,
      showModal: vi.fn(() => Promise.resolve({ confirm: true })),
      request,
    });
    let definition: PageDefinition | undefined;
    vi.stubGlobal("Page", (value: unknown) => {
      definition = value as PageDefinition;
      return value;
    });
    vi.doMock("../../utils/service-area", () => ({
      loadServiceAreaContext: options.areaError
        ? vi.fn(async () => {
            throw new Error("GET /api/v1/service-areas failed");
          })
        : vi.fn(async () => ({ selected: null })),
    }));
    vi.doMock("../../utils/pickup-point", () => ({
      loadPickupPoints: vi.fn(async () => ({ points: [], selected: null })),
    }));
    await import("./index");
    if (!definition) throw new Error("profile page was not registered");
    definition.setData = (patch) => Object.assign(definition!.data, patch);
    return { definition, navigateTo, switchTab, openLocation, makePhoneCall };
  }

  it("sends a guest order entry through the existing auth intent", async () => {
    const { definition, navigateTo, switchTab } = await loadPage();
    definition.openOrders.call(definition, {
      currentTarget: { dataset: { filter: "READY" } },
    });

    expect(storage.get("orderFilter")).toBe("READY");
    expect(navigateTo).toHaveBeenCalledWith({ url: "/pages/login/index?source=orders" , complete: expect.any(Function) });
    expect(switchTab).not.toHaveBeenCalled();
  });

  it("opens logged-in orders as a regular page from the profile tab", async () => {
    storage.set("hometown-demo-customer-session", true);
    const { definition, navigateTo, switchTab } = await loadPage();
    definition.openOrders.call(definition, {
      currentTarget: { dataset: { filter: "ALL" } },
    });

    expect(navigateTo).toHaveBeenCalledWith({ url: "/pages/orders/index" });
    expect(switchTab).not.toHaveBeenCalled();
  });

  it("routes the collected order shortcut to the existing DONE filter", async () => {
    storage.set("hometown-demo-customer-session", true);
    const { definition, navigateTo } = await loadPage();
    definition.openOrders.call(definition, { currentTarget: { dataset: { filter: "DONE" } } });
    expect(storage.get("orderFilter")).toBe("DONE");
    expect(navigateTo).toHaveBeenCalledWith({ url: "/pages/orders/index" });
  });

  it("counts a partially refunded order and opens it from the after-sales shortcut", async () => {
    storage.set("hometown-demo-customer-session", true);
    const { definition } = await loadPage();
    const { api } = await import("../../utils/api");
    const refunded = {
      id: "refunded-order", orderNo: "HT-45", status: "READY_FOR_PICKUP", totalCents: 4500,
      deliveryPlan: null, items: [], createdAt: "2026-09-30T10:00:00.000Z",
      partialRefunds: [
        { id: "refund", exceptionId: "difference", status: "SUCCEEDED", amountCents: 1500 },
      ],
    } as OrderDto;
    const earlierRefund = { ...refunded, id: "earlier-refund", orderNo: "HT-15", createdAt: "2026-09-29T10:00:00.000Z" };
    const ordinary = { ...refunded, id: "ordinary-order", partialRefunds: [] };
    vi.spyOn(api, "listOrders").mockResolvedValue([refunded, earlierRefund, ordinary]);
    vi.spyOn(api, "getMyProfile").mockRejectedValue(new Error("profile unavailable"));

    await definition.loadSummary();

    expect(definition.data).toMatchObject({ orderTotal: 3, counts: { ready: 3, afterSale: 2 } });

    definition.openOrders({ currentTarget: { dataset: { filter: "AFTER" } } });
    const nextCursor = { id: refunded.id, createdAt: refunded.createdAt };
    const readPage = vi.spyOn(api, "listOrdersPage")
      .mockResolvedValueOnce({ items: [refunded], hasMore: true, nextCursor })
      .mockResolvedValueOnce({ items: [earlierRefund], hasMore: false, nextCursor: null });
    let ordersPage!: OrdersPageDefinition;
    vi.stubGlobal("Page", (page: OrdersPageDefinition) => { ordersPage = page; return page; });
    await import("../orders/index");
    ordersPage.setData = (patch) => Object.assign(ordersPage.data, patch);
    await ordersPage.onShow();
    expect(readPage).toHaveBeenNthCalledWith(1, 20, undefined, "AFTER");
    expect(ordersPage.data.orders).toMatchObject([{ id: refunded.id, canPickup: true }]);
    await ordersPage.loadMore();
    expect(readPage).toHaveBeenNthCalledWith(2, 20, nextCursor, "AFTER");
    expect(ordersPage.data.orders).toMatchObject([{ id: refunded.id }, { id: earlierRefund.id }]);
  });

  it("keeps area failures separate from the order summary and offers an area retry", async () => {
    const { definition } = await loadPage({ areaError: true });
    await definition.loadArea.call(definition);

    expect(definition.data.areaError).toBe(
      "本地服务未启动，请在项目根目录运行 pnpm dev 后重试",
    );
    expect(definition.data.pickupPoint).toBeNull();
  });

  it("uses the current point coordinates and phone for location and call actions", async () => {
    const { definition, openLocation, makePhoneCall } = await loadPage();
    definition.data.pickupPoint = {
      id: "point-1", name: "当前点位", address: "当前地址", latitude: 39.3, longitude: 115.6, contactPhone: "13800000000",
    };
    definition.openPickupLocation.call(definition);
    definition.callPickupPoint.call(definition);
    expect(openLocation).toHaveBeenCalledWith({ latitude: 39.3, longitude: 115.6, name: "当前点位", address: "当前地址" });
    expect(makePhoneCall).toHaveBeenCalledWith({ phoneNumber: "13800000000" });
  });
});
