import type { CommerceStore } from "../core/store.js";
import type { Campaign, DeliveryPlan } from "../core/types.js";
import type { NetSalesSnapshot } from "./catalog-sales.js";

export function createCatalogViews(store: CommerceStore) {
  const publicPlan = (plan: DeliveryPlan | null) =>
    plan
      ? {
          id: plan.id,
          campaignId: plan.campaignId,
          serviceAreaId: plan.serviceAreaId,
          pickupPointId: plan.pickupPointId,
          status: plan.status,
          siteName: plan.siteName,
          address: plan.address,
          arrivalStartAt: plan.arrivalStartAt,
          arrivalEndAt: plan.arrivalEndAt,
          estimatedArrivalAt: plan.estimatedArrivalAt,
        }
      : null;
  const campaignView = async (campaign: Campaign, sales: NetSalesSnapshot) => {
    const [plan, paidBySku, points, group] = await Promise.all([
      store.getDeliveryPlanByCampaign(campaign.id),
      store.getNetSalesQuantities(campaign.id),
      store.listPickupPoints(campaign.serviceAreaId),
      campaign.campaignGroupId ? store.getCampaignGroup(campaign.campaignGroupId) : Promise.resolve(null),
    ]);
    const groupPaidQuantity = group
      ? (await Promise.all(group.campaignIds.map((id) => store.getNetSalesQuantities(id))))
          .reduce((total, quantities) => total + [...quantities.values()].reduce((sum, value) => sum + value, 0), 0)
      : [...paidBySku.values()].reduce((total, quantity) => total + quantity, 0);
    return {
      ...campaign,
      groupingMode: group?.groupingMode ?? "PER_POINT",
      groupPaidQuantity,
      campaignGroupVersion: group?.version ?? null,
      deliveryPlan: publicPlan(plan),
      pickupPoint: plan
        ? (points.find((point) => point.id === plan.pickupPointId) ?? null)
        : null,
      paidQuantity: group?.groupingMode === "ALL_POINTS"
        ? groupPaidQuantity
        : [...paidBySku.values()].reduce((total, quantity) => total + quantity, 0),
      items: campaign.items.map((item) => ({
        skuId: item.catalogSkuId,
        title: item.title,
        category: item.category,
        skuName: item.skuName,
        origin: item.origin,
        imageUrl: item.imageUrl,
        imageUrls: item.imageUrls?.length ? item.imageUrls : (item.imageUrl ? [item.imageUrl] : []),
        description: item.description ?? "",
        detailImageUrls: item.detailImageUrls ?? [],
        salesQuantity: sales.quantities.get(item.catalogSkuId) ?? 0,
        unitPriceCents: Number(item.retailPriceCents),
        stock: item.sellableQuantity,
        paidQuantity: paidBySku.get(item.catalogSkuId) ?? 0,
        soldQuantity: item.reservedQuantity,
      })),
    };
  };
  const publicCampaignView = async (campaign: Campaign, sales: NetSalesSnapshot) => {
    const [view, catalog] = await Promise.all([
      campaignView(campaign, sales),
      store.listCatalogSkus(),
    ]);
    const activeSkus = new Map(
      catalog
        .filter((sku) => sku.status === "ACTIVE")
        .map((sku) => [sku.id, sku]),
    );
    return {
      ...view,
      // Only the consumer image follows the current catalog. Campaign prices,
      // product descriptions and persisted campaign/order snapshots stay frozen.
      items: view.items.flatMap((item) => {
        const sku = activeSkus.get(item.skuId);
        if (!sku) return [];
        const imageUrls = sku.product.imageUrls?.length ? sku.product.imageUrls : (sku.product.imageUrl ? [sku.product.imageUrl] : []);
        return [{
          ...item,
          imageUrl: imageUrls[0] ?? null,
          imageUrls,
          description: sku.product.description ?? "",
          detailImageUrls: sku.product.detailImageUrls ?? [],
          salesQuantity: item.salesQuantity ?? 0,
        }];
      }),
    };
  };
  return { publicPlan, campaignView, publicCampaignView };
}
