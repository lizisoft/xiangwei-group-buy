import { cartGroupKey, clearCart, readCartGroups, removeCartLine, saveMultiCheckoutDraft, setCartGroupSelected, updateCartQuantity, type CartLine, type CartSnapshot } from '../../utils/cart';
import { formatMoney } from '../../utils/format';
import { readPickupPointSelection, type PickupPointSelection } from '../../utils/pickup-point';
import { formatChinaDateTime } from '../../utils/consumer-display';
import { compactPickupAddress } from '../../utils/pickup-label';
import { loadServiceAreaContext } from '../../utils/service-area';
import { PageLoadCoordinator } from '../../utils/page-load-guard';

interface CartGroupView extends Omit<CartSnapshot, 'items'> {
  groupKey: string;
  selected: boolean;
  unavailable: boolean;
  itemCount: number;
  totalText: string;
  items: Array<CartLine & { priceText: string; amountText: string }>;
  cutoffText: string;
  arrivalLabel: string;
  pickupPointDisplayAddress: string;
}

const areaLoad = new PageLoadCoordinator();
let enabledAreaIds: Set<string> | null = null;

function isGroupAvailable(group: CartSnapshot): boolean {
  return enabledAreaIds === null || enabledAreaIds.has(group.serviceAreaId);
}

Page({
  data: {
    groups: [] as CartGroupView[],
    pickupPoint: null as PickupPointSelection | null,
    pickupPointDisplayAddress: "",
    count: 0,
    selectedCount: 0,
    selectedGroupCount: 0,
    selectedTotal: '0.00',
    allSelected: false,
    checkingAreas: false,
    areaCheckFailed: false,
  },
  async onShow() {
    areaLoad.show();
    this.refresh();
    if (this.data.groups.length) await this.checkAreaAvailability();
  },
  onHide() { areaLoad.hide(); },
  onUnload() { areaLoad.unload(); },
  async checkAreaAvailability() {
    const guard = areaLoad.begin(0);
    this.setData({ checkingAreas: true, areaCheckFailed: false });
    try {
      const { areas } = await loadServiceAreaContext();
      if (!areaLoad.isLive(guard)) return;
      enabledAreaIds = new Set(areas.map((area) => area.id));
      this.refresh();
    } catch {
      if (areaLoad.isLive(guard)) this.setData({ areaCheckFailed: true });
    } finally {
      if (areaLoad.isLive(guard)) this.setData({ checkingAreas: false });
    }
  },
  refresh() {
    const groups = readCartGroups().map((group): CartGroupView => {
      const key = cartGroupKey(group);
      const itemCount = group.items.reduce((sum, item) => sum + item.quantity, 0);
      const cents = group.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
      const unavailable = !isGroupAvailable(group);
      return {
        ...group,
        groupKey: key,
        selected: group.selected !== false && !unavailable,
        unavailable,
        itemCount,
        totalText: formatMoney(cents),
        cutoffText: group.cutoffAt ? formatChinaDateTime(group.cutoffAt, true) : '以结算核对为准',
        arrivalLabel: group.arrivalText || '预计领取时间以订单通知为准',
        pickupPointDisplayAddress: compactPickupAddress(group.pickupPointName, group.pickupPointAddress),
        items: group.items.map((item) => ({ ...item, priceText: formatMoney(item.unitPriceCents), amountText: formatMoney(item.unitPriceCents * item.quantity) })),
      };
    });
    const selected = groups.filter((group) => group.selected);
    const total = selected.reduce((sum, group) => sum + group.items.reduce((lineSum, item) => lineSum + item.unitPriceCents * item.quantity, 0), 0);
    const pickupPoint = readPickupPointSelection();
    this.setData({
      groups,
      pickupPoint,
      pickupPointDisplayAddress: compactPickupAddress(pickupPoint?.name, pickupPoint?.address),
      count: groups.reduce((sum, group) => sum + group.itemCount, 0),
      selectedCount: selected.reduce((sum, group) => sum + group.itemCount, 0),
      selectedGroupCount: selected.length,
      selectedTotal: formatMoney(total),
      allSelected: selected.length > 0 && groups.every((group) => group.unavailable || group.selected),
    });
  },
  toggleGroup(event: WechatMiniprogram.BaseEvent) {
    const key = event.currentTarget.dataset.key as string;
    const group = this.data.groups.find((item) => item.groupKey === key);
    if (group && !group.unavailable) setCartGroupSelected(key, !group.selected);
    this.refresh();
  },
  toggleAll() {
    const select = !this.data.allSelected;
    for (const group of this.data.groups) {
      if (!group.unavailable) setCartGroupSelected(group.groupKey, select);
    }
    this.refresh();
  },
  openPickup() { void wx.navigateTo({ url: '/pages/pickup-select/index' }); },
  showPickupAddress(event: WechatMiniprogram.BaseEvent) {
    const groupKey = event.currentTarget.dataset.key as string;
    const group = this.data.groups.find((item) => item.groupKey === groupKey);
    if (!group) return;
    void wx.showModal({
      title: group.pickupPointName || "自提点地址",
      content: group.pickupPointAddress || "完整地址暂未提供，请联系平台客服确认",
      showCancel: false,
      confirmText: "知道了",
    });
  },
  changeQuantity(event: WechatMiniprogram.BaseEvent) {
    const skuId = event.currentTarget.dataset.id as string;
    const groupKey = event.currentTarget.dataset.key as string;
    const line = this.data.groups.find((group) => group.groupKey === groupKey)?.items.find((item) => item.skuId === skuId);
    if (!line) return;
    updateCartQuantity(skuId, line.quantity + Number(event.currentTarget.dataset.step), groupKey);
    this.refresh();
  },
  removeLine(event: WechatMiniprogram.BaseEvent) {
    removeCartLine(event.currentTarget.dataset.id as string, event.currentTarget.dataset.key as string);
    this.refresh();
  },
  clearAll() {
    void wx.showModal({ title: '清空购物车？', content: '所有团期和自提点的商品都将移除。', confirmText: '清空', confirmColor: '#d7472f', success: (result) => { if (result.confirm) { clearCart(); this.refresh(); } } });
  },
  checkout() {
    if (this.data.checkingAreas) return;
    const selected = readCartGroups().filter((group) => group.selected !== false && isGroupAvailable(group));
    if (!selected.length) return;
    saveMultiCheckoutDraft(selected);
    void wx.navigateTo({ url: '/pages/checkout/index?source=multi' });
  },
});
