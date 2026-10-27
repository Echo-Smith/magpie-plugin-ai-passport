// passport.hooks.ts —— Magpie 网关钩子：把活动与用量推送到 AI Passport 审批桥。
//
// Magpie 在每次模型请求路由前调用 onRequest。本插件：
//   1) 把 agent / model / 工作目录 作为「活动」推给桥（同组合 10 秒节流）
//   2) 每 30 秒轮询 Magpie 的 usage 与 quotas，把 Token 消耗与剩余额度推给桥
// 桥再通过局域网把这些显示在 AI Passport 设备上。
//
// 隐私：只上报 agent 名、模型名、目录名与汇总数字；不上报 prompt、
// 会话 ID、账号或密钥。请求体原样返回，不做任何修改。
//
// 配置（环境变量，全部可选）：
//   PASSPORT_HUB      审批桥地址，默认 http://127.0.0.1:7789
//   PASSPORT_TOKEN    审批桥 token，默认 test123
//   PASSPORT_DISABLE  设为 1 可临时关闭全部上报
const http = await import("node:http");

const HUB = (process.env.PASSPORT_HUB || "http://127.0.0.1:7789").replace(/\/$/, "");
const TOKEN = process.env.PASSPORT_TOKEN || "test123";
const DISABLED = process.env.PASSPORT_DISABLE === "1";

const THROTTLE_MS = 10_000;
const USAGE_THROTTLE_MS = 30_000;
const GATEWAY = process.env.MAGPIE_GATEWAY || "http://127.0.0.1:3425";

const lastSeen = new Map();
let lastUsageAt = 0;

function parseHubUrl() {
  try {
    const u = new URL(HUB);
    return {
      host: u.hostname,
      port: Number(u.port || 80),
      base: u.pathname.replace(/\/$/, ""),
    };
  } catch {
    return { host: "127.0.0.1", port: 7789, base: "" };
  }
}

// 用 node:http 直连：Magpie 宿主进程常带代理环境变量，
// 全局 fetch 会把这些内网请求交给代理而失败。
function post(path, payload) {
  const { host, port, base } = parseHubUrl();
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host, port, path: base + path, method: "POST",
        headers: {
          "content-type": "application/json",
          "x-approval-token": TOKEN,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => { res.resume(); resolve(true); },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: "GET" }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function humanTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "--";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

async function pollUsage() {
  const now = Date.now();
  if (now - lastUsageAt < USAGE_THROTTLE_MS) return;
  lastUsageAt = now;

  const usage = await getJson(`${GATEWAY}/v1/magpie/usage?period=7d`);
  let total = NaN;
  if (usage && Number.isFinite(usage.input)) {
    total = (usage.input || 0) + (usage.output || 0)
          + (usage.cache_read || 0) + (usage.cache_write || 0);
  }

  const raw = await getJson(`${GATEWAY}/v1/magpie/quotas`);
  const list = Array.isArray(raw?.data) ? raw.data : [];
  const quotas = list.slice(0, 3).map((q) => {
    const wins = Array.isArray(q?.windows) ? q.windows : [];
    const win = wins.find((w) => w?.name === "Total") ?? wins[0] ?? {};
    const rem = Number(win?.remaining);
    return {
      name: String(q?.name ?? "?").slice(0, 20),
      left: Number.isFinite(rem) ? `剩 ${Math.round(rem)}%` : "--",
    };
  });

  await post("/usage", { tokens: humanTokens(total), quotas });
}

export async function onRequest(body, ctx) {
  if (DISABLED) return undefined;
  try {
    const agent = ctx?.agent || "?";
    const model = String(ctx?.model || body?.model || "?").split("/").pop() || "?";
    const key = `${agent}/${model}`;
    const now = Date.now();
    if (now - (lastSeen.get(key) ?? 0) >= THROTTLE_MS) {
      lastSeen.set(key, now);
      let place = "";
      if (typeof ctx?.cwd === "string" && ctx.cwd) {
        const parts = ctx.cwd.split("/").filter(Boolean);
        place = parts.length ? parts[parts.length - 1] : ctx.cwd;
      }
      await post("/notify", {
        agent: "magpie",
        title: `${agent} / ${model}`.slice(0, 80),
        detail: place ? `at ${place}` : "",
        ttl_s: 5,
      });
    }
    pollUsage();
  } catch {
    // 上报失败绝不影响模型请求本身
  }
  return undefined;
}

export default { onRequest };
