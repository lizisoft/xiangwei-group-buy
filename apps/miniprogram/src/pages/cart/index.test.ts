import { beforeEach, describe, expect, it, vi } from 'vitest';

type CartPage = {
  data: Record<string, unknown>;
  setData: (patch: Record<string, unknown>) => void;
  refresh: () => void;
  onShow: () => Promise<void>;
  checkout: () => void;
  toggleGroup: (event: WechatMiniprogram.BaseEvent) => void;
  openPickup: () => void;
  showPickupAddress: (event: WechatMiniprogram.BaseEvent) => void;
};

describe('empty cart pickup context', () => {
  const storage = new Map<string, unknown>();
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    const navigateTo = vi.fn(() => Promise.resolve());
    vi.stubGlobal('wx', {
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      navigateTo,
      showModal: vi.fn(),
    });
    vi.stubGlobal('getApp', () => ({ globalData: { apiBaseUrl: 'http://127.0.0.1:3100', authMode: 'demo', demoLoginEnabled: true, accessToken: null, subscriptionTemplates: [] } }));
    vi.stubGlobal('Page', (definition: CartPage) => definition);
  });

  it('shows the current saved point even when the cart has no items', async () => {
    const point = {
      id: 'point-1', serviceAreaId: 'area-1', name: '松林社区自提点', address: '松林路 8 号',
      businessHours: '', pickupInstructions: '', latitude: 39.2, longitude: 115.4,
      contactName: '', contactPhone: '', status: 'ACTIVE', capacityPerDay: null,
    };
    storage.set('selectedPickupPoint', point);
    let page: CartPage | undefined;
    vi.stubGlobal('Page', (definition: CartPage) => { page = definition; return definition; });
    await import('./index');
    page!.setData = (patch) => Object.assign(page!.data, patch);
    page!.refresh.call(page);
    expect(page!.data.groups).toEqual([]);
    expect(page!.data.pickupPoint).toMatchObject({ name: '松林社区自提点', address: '松林路 8 号' });
  });

  it("opens the full address from the selected cart group rather than the current area", async () => {
    let page: CartPage | undefined;
    vi.stubGlobal('Page', (definition: CartPage) => { page = definition; return definition; });
    await import('./index');
    const showModal = vi.mocked(wx.showModal);
    page!.data.groups = [{ groupKey: 'area-b:point-b', pickupPointName: '北区三中自提点', pickupPointAddress: '河北省北区第三中学东门 2 号楼' }];
    page!.showPickupAddress.call(page, { currentTarget: { dataset: { key: 'area-b:point-b' } } } as unknown as WechatMiniprogram.BaseEvent);
    expect(showModal).toHaveBeenCalledWith(expect.objectContaining({
      title: '北区三中自提点',
      content: '河北省北区第三中学东门 2 号楼',
      showCancel: false,
    }));
  });

  it("keeps both saved groups and only checks out the area that still accepts orders", async () => {
    const { api } = await import("../../utils/api");
    const { addCartLine, readMultiCheckoutDraft } = await import("../../utils/cart");
    const areaA = { id: "area-a", name: "A 区", regionCode: "110101", orderEnabled: true } as ServiceAreaDto;
    const areaB = { ...areaA, id: "area-b", name: "B 区", regionCode: "110102" };
    const areas = vi.spyOn(api, "listServiceAreas").mockResolvedValue([{ ...areaA, orderEnabled: false }, areaB]);
    storage.set("selectedServiceArea", areaA);
    for (const area of [areaA, areaB]) {
      addCartLine({
        campaignId: area.id, campaignTitle: area.name, serviceAreaId: area.id, serviceAreaName: area.name,
        pickupPointId: "point-" + area.id, pickupPointName: area.name, pickupPointAddress: "自提地址",
      }, {
        skuId: "sku", title: "苹果", skuName: "一份", imageUrl: null, unitPriceCents: 1500, quantity: 1, maxQuantity: 5,
      });
    }
    const savedCart = storage.get("standardCart");
    let page!: CartPage;
    vi.stubGlobal("Page", (definition: CartPage) => { page = definition; return definition; });
    await import("./index");
    page.setData = (patch) => Object.assign(page.data, patch);

    await page.onShow();
    expect(page.data).toMatchObject({
      groups: [
        { serviceAreaId: "area-a", unavailable: true, selected: false },
        { serviceAreaId: "area-b", unavailable: false, selected: true },
      ],
      selectedGroupCount: 1, selectedTotal: "15.00", allSelected: true,
    });
    page.toggleGroup({ currentTarget: { dataset: { key: "area-a::point-area-a" } } } as unknown as WechatMiniprogram.BaseEvent);
    page.checkout();
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/checkout/index?source=multi" });
    expect(readMultiCheckoutDraft()?.groups.map((group) => group.serviceAreaId)).toEqual(["area-b"]);
    expect(storage.get("standardCart")).toEqual(savedCart);
    expect(storage.has("selectedServiceArea")).toBe(false);

    areas.mockResolvedValue([areaA, areaB]);
    await page.onShow();
    expect(page.data).toMatchObject({
      selectedGroupCount: 2, selectedTotal: "30.00",
      groups: [
        { serviceAreaId: "area-a", unavailable: false, selected: true },
        { serviceAreaId: "area-b", unavailable: false, selected: true },
      ],
    });
  });
});
