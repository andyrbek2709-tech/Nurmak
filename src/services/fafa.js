import { chromium } from "playwright";

const FAFA_URL = "https://fa-fa.kz";
const CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

let _bot = null;
let _chatId = null;
let monitorTimer = null;
let seenKeys = new Set();
let isRunning = false;

// Active filters set by the manager via Telegram
const filters = { from: null, to: null, cargo: null };

export function initFafa(bot, chatId) {
  _bot = bot;
  _chatId = chatId;
}

export function isMonitoringActive() { return isRunning; }

export function getFilters() { return { ...filters }; }

export function setFilter(key, value) {
  if (key in filters) filters[key] = value?.trim() || null;
}

export function clearFilters() {
  filters.from = null;
  filters.to = null;
  filters.cargo = null;
}

export async function startMonitoring() {
  if (isRunning) return;
  isRunning = true;
  seenKeys.clear();
  console.log("[FAFA] monitoring started");
  await tick();
}

export function stopMonitoring() {
  isRunning = false;
  if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
  seenKeys.clear();
  console.log("[FAFA] monitoring stopped");
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function makeKey(item) {
  return `${item.from}|${item.to}|${item.cargo}|${item.time}`
    .toLowerCase().replace(/\s+/g, "");
}

function matchesFilters(item) {
  if (filters.from && !item.from?.toLowerCase().includes(filters.from.toLowerCase())) return false;
  if (filters.to && !item.to?.toLowerCase().includes(filters.to.toLowerCase())) return false;
  if (filters.cargo && !item.cargo?.toLowerCase().includes(filters.cargo.toLowerCase())) return false;
  return true;
}

async function tick() {
  if (!isRunning) return;
  try {
    const items = await scrape();
    console.log(`[FAFA] fetched ${items.length} items`);

    const fresh = items.filter(i => {
      const k = makeKey(i);
      return k.length > 3 && !seenKeys.has(k);
    });

    const matched = fresh.filter(matchesFilters);

    for (const item of fresh) seenKeys.add(makeKey(item));

    for (const item of matched) {
      await notify(item);
    }

    if (matched.length > 0) console.log(`[FAFA] sent ${matched.length} notifications`);
  } catch (err) {
    console.error("[FAFA] tick error:", err.message);
  }

  if (isRunning) monitorTimer = setTimeout(tick, CHECK_INTERVAL_MS);
}

async function notify(item) {
  if (!_bot || !_chatId) return;
  const filterLine = [
    filters.from ? `🔍 Откуда: ${filters.from}` : null,
    filters.to ? `🔍 Куда: ${filters.to}` : null,
    filters.cargo ? `🔍 Груз: ${filters.cargo}` : null,
  ].filter(Boolean).join(" | ");

  const text = [
    `🚛 Новая заявка (FA-FA)`,
    ``,
    `📍 ${item.from || "—"} → ${item.to || "—"}`,
    `📦 ${item.cargo || "—"}`,
    `⚖ ${item.weight || "—"}`,
    `🕒 ${item.time || "—"}`,
    filterLine || "",
  ].filter(l => l !== "").join("\n");

  await _bot.telegram.sendMessage(_chatId, text.trim()).catch(e =>
    console.error("[FAFA] sendMessage error:", e.message)
  );
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return delay(Math.floor(min + Math.random() * (max - min))); }

async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ru-RU",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    await page.goto(FAFA_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await rand(1500, 2500);

    // Login if needed
    const hasAuth = await page.$(".user-info, .profile-link, [href*='logout'], [href*='exit'], .lk-link").catch(() => null);
    if (!hasAuth) await doLogin(page);

    // Try known cargo page paths
    const cargoPaths = ["/loads", "/cargoes", "/cargo", "/search", "/board"];
    let loaded = false;
    for (const path of cargoPaths) {
      try {
        const resp = await page.goto(`${FAFA_URL}${path}`, { waitUntil: "domcontentloaded", timeout: 15000 });
        if (resp && resp.ok()) { loaded = true; break; }
      } catch (_) { /* try next */ }
      await rand(500, 800);
    }

    if (!loaded) {
      console.log("[FAFA] Could not find cargo page, staying on:", page.url());
    }

    await rand(2000, 3000);
    console.log(`[FAFA] scraping URL: ${page.url()}, title: ${await page.title()}`);

    return await extractItems(page);
  } finally {
    await browser.close();
  }
}

async function doLogin(page) {
  const login = process.env.FAFA_LOGIN;
  const password = process.env.FAFA_PASSWORD;
  if (!login || !password) throw new Error("FAFA_LOGIN / FAFA_PASSWORD env vars missing");

  console.log("[FAFA] logging in...");

  // Click login link if present
  const loginLink = await page.$("a[href*='login'], a[href*='signin'], a[href*='enter'], .login-btn, .btn-login").catch(() => null);
  if (loginLink) { await loginLink.click(); await rand(1000, 1500); }

  // Fill credentials
  await page.fill(
    "input[name='login'], input[name='email'], input[name='username'], input[type='email'], #login, #email",
    login
  ).catch(() => {});
  await rand(500, 900);
  await page.fill("input[type='password'], input[name='password'], #password", password).catch(() => {});
  await rand(500, 900);

  // Force click handles elements outside viewport
  const submitBtn = await page.$("button[type='submit'], input[type='submit'], .btn-login, .login-submit, form button").catch(() => null);
  if (submitBtn) {
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    await submitBtn.click({ force: true }).catch(() => {});
  }
  await page.waitForLoadState("domcontentloaded");
  await rand(2000, 3000);
  console.log(`[FAFA] login done, URL: ${page.url()}`);
}

async function extractItems(page) {
  return page.evaluate(() => {
    const selectors = [
      ".cargo-item", ".load-item", ".order-item", ".search-item",
      ".result-item", ".list-item", ".card", ".offer-item",
      "table tbody tr", ".table tbody tr",
      "[class*='cargo-row']", "[class*='load-row']", "[class*='item']",
    ];

    let rows = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 1) { rows = Array.from(found); break; }
    }

    if (rows.length === 0) {
      // Last resort: grab all table rows
      rows = Array.from(document.querySelectorAll("tr")).filter(r => r.querySelectorAll("td").length >= 2);
    }

    const getText = (el, selList) => {
      for (const s of selList) {
        const f = el.querySelector(s);
        if (f?.textContent?.trim()) return f.textContent.trim();
      }
      return "";
    };

    return rows.slice(0, 50).map(row => {
      const cells = Array.from(row.querySelectorAll("td, .cell, [class*='col']"))
        .map(c => c.textContent?.trim() || "");

      return {
        from: getText(row, ["[class*='from']", "[class*='origin']", "[class*='depart']", "[data-label*='от']"]) || cells[1] || "",
        to: getText(row, ["[class*='to']", "[class*='dest']", "[class*='arrive']", "[data-label*='до']"]) || cells[2] || "",
        cargo: getText(row, ["[class*='cargo']", "[class*='goods']", "[class*='груз']", "[class*='name']"]) || cells[3] || "",
        weight: getText(row, ["[class*='weight']", "[class*='mass']", "[class*='вес']"]) || cells[4] || "",
        time: getText(row, ["[class*='date']", "[class*='time']", "[class*='created']", "[class*='дата']"]) || cells[0] || "",
      };
    }).filter(i => i.from || i.to || i.cargo);
  });
}
