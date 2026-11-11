// passport.hooks.ts —— Magpie 网关钩子（唯一的 Passport 插件，已合并原
// passport-gateway/magpie-plugin/notify.hooks.ts）：把用量与任务完成提醒
// 推送到审批桥。
//
// Magpie 在每次模型请求/响应前后调用 onRequest / onResponse。本插件：
//   1) 每 30 秒轮询 Magpie 的 usage 与 quotas，把 Token 消耗与剩余额度推给桥
//      quotas 首条为 Total（各 provider 剩余百分比的平均），其后最多 3 家明细；
//      设备首页绿卡与用量页首行显示 Total。
//   2) 任务完成提醒：网关层没有"任务结束"事件，用空闲近似——某 agent 停止
//      请求/响应满 3 分钟视为完成，推一条提醒；每 agent 15 分钟最多一次。
//   3) 不推送逐次活动（太频繁，设备端已下线该类通知）。
//
// 隐私：只上报 agent 名、模型名与汇总数字；不上报 prompt、
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

const USAGE_THROTTLE_MS = 30_000;
const GATEWAY = process.env.MAGPIE_GATEWAY || "http://127.0.0.1:3425";

// 任务完成（空闲近似）参数
const IDLE_MS = 3 * 60_000;
const DONE_COOLDOWN_MS = 15 * 60_000;
const lastActivity = new Map();
const lastDoneAt = new Map();
const idleTimers = new Map();

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

let lastUsageAt = 0;

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
  const picks = list.map((q) => {
    const wins = Array.isArray(q?.windows) ? q.windows : [];
    const win = wins.find((w) => w?.name === "Total") ?? wins[0] ?? {};
    const rem = Number(win?.remaining);
    return {
      name: String(q?.name ?? "?").slice(0, 20),
      left: Number.isFinite(rem) ? `${Math.round(rem)}%` : null,
    };
  }).filter((p) => p.left !== null);
  const quotas = [];
  if (picks.length) {
    const avg = Math.round(
      picks.reduce((a, p) => a + parseFloat(p.left), 0) / picks.length);
    quotas.push({ name: "Total", left: `${avg}%` });
  }
  quotas.push(...picks.slice(0, 3).map((p) => ({ name: p.name, left: p.left })));

  await post("/usage", { tokens: humanTokens(total), quotas });
}

// 某 agent 的活动（请求/响应）到达时调用：刷新活动时间并重新武装空闲定时器。
// 定时器到点且期间无新活动 → 推一条「已完成」提醒（带冷却，防连续误报）。
// 设备端中文字库无「务」字，文案用「已完成」。
function touchActivity(agent, model) {
  const now = Date.now();
  lastActivity.set(agent, now);
  const old = idleTimers.get(agent);
  if (old) clearTimeout(old);
  idleTimers.set(agent, setTimeout(async () => {
    idleTimers.delete(agent);
    if (Date.now() - (lastActivity.get(agent) || 0) < IDLE_MS) return;
    if (Date.now() - (lastDoneAt.get(agent) || 0) < DONE_COOLDOWN_MS) return;
    lastDoneAt.set(agent, Date.now());
    await post("/notify", {
      agent: "magpie",
      title: `${agent} 已完成`.slice(0, 80),
      detail: model && model !== "?" ? `model ${model}` : "",
      ttl_s: 10,
    });
  }, IDLE_MS));
}

export async function onRequest(body, ctx) {
  if (DISABLED) return undefined;
  try {
    const agent = ctx?.agent || "?";
    const model = String(ctx?.model || body?.model || "?").split("/").pop() || "?";
    touchActivity(agent, model);
    pollUsage();
  } catch {
    // 上报失败绝不影响模型请求本身
  }
  return undefined;
}

// 响应后同样视为活动：任务往往在最后一次响应后结束，空闲检测从这里起算
export async function onResponse(reply, ctx) {
  if (DISABLED) return undefined;
  try {
    const agent = ctx?.agent || "?";
    const model = String(ctx?.model || reply?.model || "?").split("/").pop() || "?";
    touchActivity(agent, model);
  } catch {
    // 提醒失败绝不影响响应本身
  }
  return undefined;
}

export default { onRequest, onResponse };
