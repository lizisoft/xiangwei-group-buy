import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { GeoPlace } from "../src/modules/service-areas/geo-search.js";

// A single simulated candidate for exercising the normal search, reverse lookup
// and district validation without external map services or stored business data.
const place = {
  title: "本地演练自提点",
  address: "北京市东城区本地演练自提点",
  latitude: 39.9167,
  longitude: 116.4167,
  adcode: "110101",
} satisfies GeoPlace;
const matches = (latitude: number, longitude: number) =>
  latitude === place.latitude && longitude === place.longitude;

const config = loadConfig({
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: process.env.PORT,
  DATA_STORE: "memory",
  QUEUE_DRIVER: "memory",
  AUTH_PROVIDER: "demo",
  PAYMENT_PROVIDER: "mock",
  PRODUCT_IMAGE_DIR: fileURLToPath(new URL("../node_modules/.cache/preview-images", import.meta.url)),
});
const app = await buildApp({
  config,
  geoSearch: {
    async search(query) {
      return query.includes("本地演练") ? [place] : [];
    },
    async reverse(latitude, longitude) {
      return matches(latitude, longitude) ? place : null;
    },
  },
  reverseLocationAdapter: {
    async reverse(latitude, longitude) {
      if (!matches(latitude, longitude)) return { status: "UNMAPPABLE" };
      return {
        status: "MAPPED",
        coordinateSystem: "GCJ-02",
        latitude,
        longitude,
        providerAdministrativeId: place.adcode,
        directoryRegionCode: place.adcode,
        displayAddress: place.address,
      };
    },
  },
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await app.listen({ host: config.HOST, port: config.PORT });
