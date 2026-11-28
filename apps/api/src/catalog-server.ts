import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import Fastify from "fastify";
import { ZodError } from "zod";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { BusinessError } from "@hometown/domain";
import { AuthService, WechatApiCodeExchange } from "./modules/auth/wechat-auth.js";
import { WechatApiPhoneExchange } from "./modules/auth/wechat-phone.js";
import { calculateNetSalesSnapshot } from "./modules/catalog/catalog-sales.js";
import type { PickupPoint } from "./modules/core/types.js";
import { createCatalogViews } from "./modules/catalog/catalog-views.js";
import { CampaignService } from "./modules/campaigns/campaign-service.js";
import { NoopCampaignScheduler } from "./modules/campaigns/campaign-scheduler.js";
import { MysqlStore } from "./modules/core/mysql-store.js";
import { ProductImages, PRODUCT_DETAIL_IMAGE_MAX_BYTES } from "./modules/media/product-images.js";
import { registerConsumerWechatLoginRoute } from "./routes/auth-routes.js";
import { publicProfile } from "./routes/profile-routes.js";
import { registerPublicHomepageBannerRoute } from "./routes/merchandising-routes.js";
import { registerPublicCatalogRoutes } from "./routes/public-catalog-routes.js";

const databaseUrl = process.env.CATALOG_DATABASE_URL;
const imageDirectory = process.env.PRODUCT_IMAGE_DIR;
const publicHost = process.env.CATALOG_PUBLIC_HOST;
const proxyIp = process.env.CATALOG_PROXY_IP;
if (!databaseUrl || !imageDirectory || publicHost !== "saas.liziqi.icu" || !proxyIp || !isIPv4(proxyIp))
  throw new Error("只读目录服务要求独立数据库、图片目录、乡味集 HTTPS 域名和网关代理地址");

const store = MysqlStore.create(databaseUrl);
const mode = process.env.CATALOG_RUNTIME ?? "catalog-only";
if (mode !== "catalog-only" && mode !== "catalog-with-wechat-login")
  throw new Error("未知的乡味集目录服务模式");

const privacyVersion = process.env.PRIVACY_NOTICE_VERSION;
let accountStore: MysqlStore | undefined;
let authService: AuthService | undefined;
if (mode === "catalog-with-wechat-login") {
  const accountUrl = process.env.CATALOG_AUTH_DATABASE_URL;
  const appId = process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_APP_SECRET;
  if (!accountUrl || appId !== "wx323bfd5b1c550534" || !appSecret || !/^[0-9a-f]{32}$/i.test(appSecret) ||
      !privacyVersion || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(privacyVersion))
    throw new Error("微信登录阶段缺少乡味集专用账号配置");
  const invalidDatabase = "微信账号存储必须使用同一个乡味集独立数据库的专用账号";
  try {
    const reader = new URL(databaseUrl);
    const writer = new URL(accountUrl);
    if (reader.protocol !== "mysql:" || writer.protocol !== reader.protocol || writer.host !== reader.host ||
        writer.pathname !== "/xiangwei_catalog" || reader.pathname !== writer.pathname ||
        writer.username !== "xiangwei_account" || reader.username !== "xiangwei_reader")
      throw new Error(invalidDatabase);
  } catch {
    // URL parsing errors may include the original password-bearing input.
    throw new Error(invalidDatabase);
  }
  accountStore = MysqlStore.create(accountUrl);
  const persistenceMode = await accountStore.getPersistenceMode().catch(() => null);
  if (persistenceMode !== "LEGACY")
    throw new Error("微信账号存储未就绪或未通过聚合模式验证");
  authService = new AuthService(accountStore, new WechatApiCodeExchange(appId, appSecret),
    604_800, new WechatApiPhoneExchange(appId, appSecret), privacyVersion);
}
const loginEnabled = Boolean(authService);
const accountWritePaths = new Set(["/api/v1/auth/wechat/login", "/api/v1/auth/logout"]);
const campaigns = new CampaignService(store, new NoopCampaignScheduler());
const { publicPlan, publicCampaignView } = createCatalogViews(store);
const images = new ProductImages(imageDirectory, "/api/v1/product-images/", {
  maxStoredBytes: PRODUCT_DETAIL_IMAGE_MAX_BYTES,
});
const app = Fastify({
  bodyLimit: 4096,
  requestTimeout: 10_000,
  // The host gateway replaces X-Forwarded-For. Never trust an additional hop.
  trustProxy: (address, hop) => hop === 0 && (address === proxyIp || address === `::ffff:${proxyIp}`),
});
app.addHook("onClose", async () => {
  await Promise.all([store.close(), accountStore?.close()]);
});
await app.register(helmet, { contentSecurityPolicy: false });
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
app.addHook("onRequest", async (request, reply) => {
  reply.header("cache-control", "no-store");
  if (request.headers.host !== publicHost || request.headers["x-forwarded-proto"] !== "https") {
    return reply.code(426).send({ code: "HTTPS_REQUIRED", message: "请使用乡味集 HTTPS 入口" });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const path = request.url.split("?", 1)[0]!;
    if (!loginEnabled || request.method !== "POST" || !accountWritePaths.has(path)) {
      return reply.code(503).send({
        code: "CATALOG_ONLY",
        message: loginEnabled ? "下单和支付尚未开放" : "当前仅开放浏览，登录、下单和支付尚未开放",
      });
    }
  }
});
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ code: "VALIDATION_ERROR", message: "请求参数无效" });
  if (error instanceof BusinessError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 429) return reply.code(429).send({ code: "RATE_LIMITED", message: "请求过多，请稍后重试" });
  return reply.code(503).send({ code: "CATALOG_UNAVAILABLE", message: "目录暂不可用" });
});
// The retired site shared this origin. Remove its local keys before rendering
// any content without reading values, touching other namespaces, or setting cookies.
const cleanupScript = `for(const name of ["localStorage","sessionStorage"]){try{const store=window[name];for(let i=store.length-1;i>=0;i--){const key=store.key(i);if(key?.startsWith("uniform_web_"))store.removeItem(key);}}catch{}}`;
const cleanupScriptHash = createHash("sha256").update(cleanupScript).digest("base64");
app.get("/", async (_request, reply) => reply
  .header("content-security-policy", `default-src 'none'; script-src 'sha256-${cleanupScriptHash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
  .type("text/html; charset=utf-8")
  .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>乡味集</title><script>${cleanupScript}</script></head><body><main><h1>乡味集</h1><p>${loginEnabled ? "目录浏览和微信登录已开放，下单和支付尚未开放。" : "目录浏览已开放，登录、下单和支付尚未开放。"}</p><ul><li><a href="/api/v1/catalog/categories">商品分类</a></li><li><a href="/api/v1/campaigns">在售团期</a></li><li><a href="/api/v1/service-areas">服务区域</a></li><li><a href="/api/v1/pickup-points">自提点</a></li></ul></main></body></html>`));
function publishedPickupPoint(point: PickupPoint) {
  const { id, serviceAreaId, name, address, businessHours, pickupInstructions, latitude, longitude,
    contactName, contactPhone, status, photoUrl } = point;
  return { id, serviceAreaId, name, address, businessHours, pickupInstructions, latitude, longitude,
    contactName, contactPhone, status, photoUrl };
}

app.get("/health/ready", async () => {
  await store.readSnapshot((snapshot) => snapshot.listServiceAreas());
  if (accountStore) await accountStore.readSnapshot((snapshot) => snapshot.listServiceAreas());
  return { status: "ok", mode, dependencies: {
    catalogDataStore: "ok", ...(accountStore ? { accountDataStore: "ok" } : {}),
  }, login: loginEnabled, ordering: false, payment: false };
});

if (authService && privacyVersion && accountStore) {
  const authentication = authService;
  const accounts = accountStore;
  registerConsumerWechatLoginRoute(app, authentication, privacyVersion);
  app.get("/api/v1/me/profile", async (request) => accounts.readSnapshot(async (snapshot) => {
    const actor = await authentication.authenticate(request.headers.authorization, snapshot);
    if (!actor) throw new BusinessError("AUTH_REQUIRED", "请先登录", 401);
    const user = await snapshot.getUser(actor.userId);
    if (!user || user.status !== "ACTIVE") throw new BusinessError("AUTH_REQUIRED", "请先登录", 401);
    return { data: publicProfile(user) };
  }));
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const actor = await accounts.readSnapshot((snapshot) => authentication.authenticate(request.headers.authorization, snapshot));
    if (!actor) throw new BusinessError("AUTH_REQUIRED", "请先登录", 401);
    await authentication.logout(request.headers.authorization);
    return reply.status(204).send();
  });
}
registerPublicCatalogRoutes(app, {
  readSnapshot: (work) => store.readSnapshot(work),
  campaigns,
  listServiceAreas: () => store.listServiceAreas(),
  listProductCategories: () => store.listProductCategories(),
  listPickupPoints: (id) => store.listPickupPoints(id),
  publicPickupPoint: publishedPickupPoint,
  getDeliveryPlanByCampaign: (id) => store.getDeliveryPlanByCampaign(id),
  getSalesSnapshot: () => calculateNetSalesSnapshot(store),
  withCampaignItems: async (campaign, sales) => {
    const view = await publicCampaignView(campaign, sales);
    const { id, campaignGroupId, groupingMode, groupPaidQuantity, title, serviceAreaId, cutoffAt, dispatchAt, estimatedArrivalStartAt,
      estimatedArrivalEndAt, minTotalQuantity, failureAction, status, deliveryPlan, pickupPoint, paidQuantity, items } = view;
    return { id, campaignGroupId, groupingMode, groupPaidQuantity, title, serviceAreaId, cutoffAt, dispatchAt, estimatedArrivalStartAt,
      estimatedArrivalEndAt, minTotalQuantity, failureAction, status, deliveryPlan,
      pickupPoint: pickupPoint && publishedPickupPoint(pickupPoint), paidQuantity, items };
  },
  publicDeliveryPlan: publicPlan,
});
registerPublicHomepageBannerRoute(app, store);
app.get<{ Params: { filename: string } }>("/api/v1/product-images/:filename", async (request, reply) => {
  const image = await images.read(request.params.filename);
  return reply.type("image/webp")
    .header("Cross-Origin-Resource-Policy", "cross-origin")
    .header("Cache-Control", "public, max-age=31536000, immutable")
    .send(image);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void app.close());
await app.listen({ host: "0.0.0.0", port: 3100 });
