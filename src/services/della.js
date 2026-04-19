import { chromium } from "playwright";

const DELLA_URL = "https://www.della.kz";
const CARGO_PATH = "/search/";
const CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

let _bot = null;
let _chatId = null;
let monitorTimer = null;
let seenKeys = new Set();
let isRunning = false;

export function initDella(bot, chatId) {
  _bot = bot;
  _chatId = chatId;
}

export function isMonitoringActive() {
  return isRunning;
}

export async function startMonitoring() {
  if (isRunning) return;
  isRunning = true;
  seenKeys.clear();
  console.log("[DELLA] monitoring started");
  await tick();
}

export function stopMonitoring() {
  isRunning = false;
  if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
  seenKeys.clear();
  console.log("[DELLA] monitoring stopped");
}

// ─── Internal ────────────────────────────────────────────────────────────────

function makeKey(item) {
  return `${item.from}|${item.to}|${item.cargo}|${item.time}`
    .toLowerCase()
    .replace(/\s+/g, "");
}

async function tick() {
  if (!isRunning) return;

  try {
    const items = await scrape();
    console.log(`[DELLA] fetched ${items.length} items`);

    const newItems = items.filter(i => {
      const k = makeKey(i);
      return k.length > 3 && !seenKeys.has(k);
    });

    for (const item of newItems) {
      seenKeys.add(makeKey(item));
      await notify(item);
    }

    if (newItems.length > 0) {
      console.log(`[DELLA] sent ${newItems.length} new notifications`);
    }
  } catch (err) {
    console.error("[DELLA] tick error:", err.message);
  }

  if (isRunning) {
    monitorTimer = setTimeout(tick, CHECK_INTERVAL_MS);
  }
}

async function notify(item) {
  if (!_bot || !_chatId) return;
  const text = [
    `🚛 Новая заявка (DELLA)`,
    ``,
    `📍 ${item.from || "—"} → ${item.to || "—"}`,
    `📦 ${item.cargo || "—"}`,
    `⚖ ${item.weight || "—"}`,
    `🕒 ${item.time || "—"}`,
  ].join("\n");
  await _bot.telegram.sendMessage(_chatId, text).catch(e =>
    console.error("[DELLA] sendMessage error:", e.message)
  );
}

// ─── Scraper ─────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min = 800, max = 2000) {
  return delay(Math.floor(min + Math.random() * (max - min)));
}

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

    // Load main page
    await page.goto(DELLA_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(1500, 2500);

    // Login if not already authenticated
    const needLogin = await page.$("input[type='password']").catch(() => null);
    const hasUserMenu = await page.$(".lk-link, .user-menu, .cabinet, [href*='cabinet'], [href*='logout']").catch(() => null);

    if (!hasUserMenu) {
      await doLogin(page);
    }

    // Navigate to cargo search page
    await page.goto(`${DELLA_URL}${CARGO_PATH}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(2000, 3000);

    console.log(`[DELLA] cargo page URL: ${page.url()}`);

    const items = await extractItems(page);
    return items;
  } finally {
    await browser.close();
  }
}

async function doLogin(page) {
  const login = process.env.DELLA_LOGIN;
  const password = process.env.DELLA_PASSWORD;

  if (!login || !password) {
    throw new Error("DELLA_LOGIN or DELLA_PASSWORD env vars not set");
  }

  console.log("[DELLA] attempting login...");

  // Find login input (della.kz uses "Логин:" label — typically a text or email input)
  const loginInput = await page.$(
    "input[name='login'], input[name='username'], input[name='email'], input[type='email'], #login, #username"
  ).catch(() => null);

  if (!loginInput) {
    // Try clicking a "Войти" link first
    const loginLink = await page.$(
      "a[href*='login'], a[href*='enter'], a[href*='signin'], .login-btn, .enter-btn"
    ).catch(() => null);
    if (loginLink) {
      await loginLink.click();
      await randomDelay(1000, 1500);
    }
  }

  // Fill login
  await page.fill(
    "input[name='login'], input[name='username'], input[name='email'], input[type='email'], #login",
    login
  );
  await randomDelay(500, 900);

  // Fill password
  await page.fill("input[type='password'], input[name='password'], #password", password);
  await randomDelay(500, 900);

  // Submit
  await page.click(
    "button[type='submit'], input[type='submit'], .login-submit, .btn-login, .enter-btn, button.btn"
  );
  await page.waitForLoadState("domcontentloaded");
  await randomDelay(2000, 3000);

  console.log(`[DELLA] login done, URL: ${page.url()}`);
}

async function extractItems(page) {
  // Log page title + a hint of HTML for debugging on first runs
  const title = await page.title();
  console.log(`[DELLA] page title: ${title}`);

  return page.evaluate(() => {
    // Selector priority list — della.kz /search/ page
    const candidateSelectors = [
      ".cargo-item",
      ".search-item",
      ".result-item",
      ".order-item",
      ".list-item",
      "table tbody tr",
      ".table-row",
      "[class*='cargo-row']",
      "[class*='search-row']",
      "[class*='item-row']",
    ];

    let rows = [];
    for (const sel of candidateSelectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        rows = Array.from(found);
        break;
      }
    }

    // Helper: try multiple selectors within a row, return first match
    const getText = (el, selectors) => {
      for (const s of selectors) {
        const found = el.querySelector(s);
        if (found?.textContent?.trim()) return found.textContent.trim();
      }
      return "";
    };

    return rows.slice(0, 50).map(row => {
      // Get all cells for positional fallback
      const cells = Array.from(row.querySelectorAll("td, .cell, [class*='col-']"))
        .map(c => c.textContent?.trim() || "");

      return {
        from: getText(row, [
          "[class*='from']", "[class*='origin']", "[class*='depart']",
          "[data-label*='от']", "[data-label*='from']",
        ]) || cells[1] || "",
        to: getText(row, [
          "[class*='to']", "[class*='dest']", "[class*='arrive']",
          "[data-label*='до']", "[data-label*='to']",
        ]) || cells[2] || "",
        cargo: getText(row, [
          "[class*='cargo']", "[class*='goods']", "[class*='груз']",
          "[class*='product']", "[data-label*='груз']",
        ]) || cells[3] || "",
        weight: getText(row, [
          "[class*='weight']", "[class*='mass']", "[class*='вес']",
          "[data-label*='вес']", "[data-label*='weight']",
        ]) || cells[4] || "",
        time: getText(row, [
          "[class*='date']", "[class*='time']", "[class*='created']",
          "[class*='дата']", "[data-label*='дата']",
        ]) || cells[0] || "",
      };
    }).filter(i => i.from || i.to || i.cargo);
  });
}
