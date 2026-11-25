import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const service = process.argv[2];
if (service !== undefined && service !== "api" && service !== "admin") {
  globalThis.console.error("用法：node scripts/dev.mjs [api|admin]");
  process.exit(1);
}

const preview = service === undefined;
const apiPort = process.env.DEV_API_PORT ?? process.env.PORT ?? "3100";
const adminPort = process.env.DEV_ADMIN_PORT ?? "5173";

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(Number(port), "127.0.0.1", () => server.close(resolve));
  });
}

if (preview) {
  try {
    const ports = [Number(apiPort), Number(adminPort)];
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535) || ports[0] === ports[1]) {
      throw new Error("API 和后台需要不同的有效端口");
    }
    await Promise.all([checkPort(apiPort), checkPort(adminPort)]);
  } catch (error) {
    globalThis.console.error(`本地预览无法启动：${error.message}`);
    process.exit(1);
  }
}

const shared = ["packages/api-contracts"];
if (service !== "admin") shared.unshift("packages/domain");
const build = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--build", "--force", ...shared], {
  cwd: root,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const children = new Set();
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (process.platform === "win32" && child.pid) {
      // Node's API watcher has a child process of its own on Windows.
      const taskkill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("error", () => child.kill());
    } else {
      child.kill("SIGTERM");
    }
  }
}

function start(name, directory, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: directory,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...extraEnv },
  });
  children.add(child);
  child.once("error", (error) => {
    globalThis.console.error(`[${name}] ${error.message}`);
    children.delete(child);
    stop(1);
  });
  child.once("exit", (code) => {
    children.delete(child);
    if (!stopping && code !== 0)
      globalThis.console.error(`[${name}] 已退出（${code ?? "未知"}）`);
    stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

if (service !== "admin") {
  const args = ["--watch", "--import", "tsx"];
  if (!preview && existsSync(join(root, ".env"))) args.unshift("--env-file=../../.env");
  args.push(preview ? "dev/preview.ts" : "src/server.ts");
  start("API", join(root, "apps/api"), args, preview ? { PORT: apiPort } : {});
}

if (service !== "api") {
  const directory = join(root, "apps/admin-web");
  const adminRequire = createRequire(join(directory, "package.json"));
  const vite = join(dirname(adminRequire.resolve("vite/package.json")), "bin/vite.js");
  const localApi = `http://127.0.0.1:${apiPort}`;
  start("后台", directory, [vite, "--host", "127.0.0.1", "--port", adminPort, "--strictPort"], {
    ...(preview ? { NODE_ENV: "development", VITE_AUTH_MODE: "demo" } : {}),
    VITE_API_TARGET: preview ? localApi : process.env.VITE_API_TARGET ?? localApi,
    VITE_LOCAL_PREVIEW: String(preview),
  });
}
