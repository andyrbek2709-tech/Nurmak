import { chromium } from "playwright";
import { loadBotSetting, saveBotSetting } from "./supabase.js";

const FAFA_URL = "https://fa-fa.kz";
const SEARCH_URL = `${FAFA_URL}/search_load/`;
const CHECK_INTERVAL_MS = 3 * 60 * 1000;

let _bot = null;
let _chatId = null;
let monitorTimer = null;
let seenKeys = new Set();
let isRunning = false;

// Filters set by manager via Telegram
const filters = { from: null, to: null, cargo: null, truck_type: null };

export function initFafa(bot, chatId) {
  _bot = bot; _chatId = chatId;
  // Load persisted filters on startup
  loadBotSetting("filters").then(val => {
    if (val) {
      try {
        const saved = JSON.parse(val);
        Object.assign(filters, saved);
        console.log("[FAFA] filters loaded from DB:", JSON.stringify(filters));
      } catch (_) {}
    }
  }).catch(() => {});
}
export function isMonitoringActive() { return isRunning; }
export function getFilters() { return { ...filters }; }
export function setFilter(key, value) {
  if (key in filters) {
    filters[key] = value?.trim() || null;
    saveBotSetting("filters", JSON.stringify(filters)).catch(() => {});
  }
}
export function clearFilters() {
  filters.from = null; filters.to = null;
  filters.cargo = null; filters.truck_type = null;
  saveBotSetting("filters", JSON.stringify(filters)).catch(() => {});
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

// One-time search — runs once and sends ALL matched items regardless of seenKeys
export async function runOnce() {
  console.log("[FAFA] running one-time search...");
  try {
    const items = await scrape();
    console.log(`[FAFA] one-time: fetched ${items.length} items`);
    const matched = items.filter(matchesFilters);
    console.log(`[FAFA] one-time: matched ${matched.length} items`);
    return matched;
  } catch (err) {
    console.error("[FAFA] runOnce error:", err.message);
    throw err;
  }
}

// ─── Filtering ────────────────────────────────────────────────────────────────

const COUNTRY_ALIASES = {
  "россия": "RU", "казахстан": "KZ", "беларусь": "BY", "беларуссия": "BY",
  "узбекистан": "UZ", "кыргызстан": "KG", "киргизия": "KG",
  "таджикистан": "TJ", "туркменистан": "TM", "азербайджан": "AZ",
  "грузия": "GE", "армения": "AM", "китай": "CN",
};

function matchesFilters(item) {
  const matches = (field, filterVal) => {
    if (!filterVal) return true;
    const val = field?.toLowerCase() || "";
    const flt = filterVal.toLowerCase();
    if (val.includes(flt)) return true;
    const code = COUNTRY_ALIASES[flt];
    if (code && val.includes(code.toLowerCase())) return true;
    return false;
  };
  if (!matches(item.from, filters.from)) return false;
  if (!matches(item.to, filters.to)) return false;
  if (!matches(item.cargo, filters.cargo)) return false;
  if (!matches(item.truck_type, filters.truck_type)) return false;
  return true;
}

// ─── Tick / notify ────────────────────────────────────────────────────────────

function makeKey(item) {
  return `${item.from}|${item.to}|${item.cargo}|${item.time}`
    .toLowerCase().replace(/\s+/g, "");
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
    for (const item of matched) await notify(item);

    if (matched.length > 0) console.log(`[FAFA] sent ${matched.length} notifications`);
  } catch (err) {
    console.error("[FAFA] tick error:", err.message);
  }
  if (isRunning) monitorTimer = setTimeout(tick, CHECK_INTERVAL_MS);
}

async function notify(item) {
  if (!_bot || !_chatId) return;
  const text = buildMessage(item);
  await _bot.telegram.sendMessage(_chatId, text).catch(e =>
    console.error("[FAFA] sendMessage error:", e.message)
  );
}

export function buildMessage(item) {
  return [
    `🚛 Новая заявка (FA-FA)`,
    ``,
    `📍 ${item.from || "—"} → ${item.to || "—"}`,
    `📦 ${item.cargo || "—"}`,
    `🚛 ${item.truck_type || "—"}`,
    `⚖ ${item.weight || "—"}`,
    `🕒 ${item.time || "—"}`,
  ].join("\n");
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
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(FAFA_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await rand(1500, 2500);

    const hasAuth = await page.$(".user-info, .profile-link, [href*='logout'], [href*='exit'], .lk-link").catch(() => null);
    if (!hasAuth) await doLogin(page);

    // Navigate to search page
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await rand(1500, 2000);

    // Fill search form with filters (site-side filtering)
    await fillSearchForm(page);

    await rand(2000, 3000);
    console.log(`[FAFA] scraping URL: ${page.url()}, title: ${await page.title()}`);

    const items = await extractItems(page);
    items.slice(0, 3).forEach((it, i) =>
      console.log(`[FAFA] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" truck="${it.truck_type}"`)
    );
    return items;
  } finally {
    await browser.close();
  }
}

async function fillSearchForm(page) {
  const hasFilters = filters.from || filters.to || filters.truck_type;
  if (!hasFilters) return;

  // Fill input and pick first autocomplete suggestion (div.av1)
  const typeAndPickSuggestion = async (inputId, value) => {
    const sel = `#${inputId}`;

    // Remove any overlay blocking the input
    await page.evaluate(() => {
      document.querySelectorAll('[class*="csr-"]').forEach(el => el.remove());
    });

    // Click + clear + type to trigger native autocomplete events
    try {
      await page.click(sel, { timeout: 4000, force: true });
    } catch (_) {
      await page.evaluate((id) => document.getElementById(id)?.focus(), inputId);
    }
    await page.fill(sel, "", { force: true }).catch(() => {});
    await page.type(sel, value, { delay: 80 });

    await rand(2000, 2500);

    const picked = await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll("div.av1")).filter(d => d.offsetParent);
      if (!divs.length) return null;
      divs[0].click();
      return divs[0].textContent.trim();
    });
    console.log(`[FAFA] #${inputId} suggestion: "${picked}"`);

    // Fallback: ensure input value is set even without autocomplete pick
    if (!picked) {
      await page.evaluate(({ id, v }) => {
        const inp = document.getElementById(id);
        if (inp) { inp.value = v; inp.dispatchEvent(new Event("change", { bubbles: true })); }
      }, { id: inputId, v: value });
    }

    await rand(800, 1000);
    return picked;
  };

  // City[1] = #search1 (from), city_end = #search10 (to)
  if (filters.from) await typeAndPickSuggestion("search1", filters.from);
  if (filters.to) await typeAndPickSuggestion("search10", filters.to);

  // Truck type select
  if (filters.truck_type) {
    await page.evaluate((t) => {
      const sel = document.querySelector("select[name='car_type'], select");
      if (!sel) return;
      const opt = Array.from(sel.options).find(o => o.text.toLowerCase().includes(t.toLowerCase()));
      if (opt) sel.value = opt.value;
    }, filters.truck_type).catch(() => {});
  }

  // Submit
  await page.evaluate(() => {
    const btn = document.querySelector("input[name='car_search']");
    if (btn) btn.click();
  });
  console.log("[FAFA] search submitted");

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  try { await page.waitForSelector("tr td a", { timeout: 10000 }); } catch (_) {}
  await rand(800, 1200);
  console.log(`[FAFA] search done, URL: ${page.url()}`);
}

async function doLogin(page) {
  const login = process.env.FAFA_LOGIN;
  const password = process.env.FAFA_PASSWORD;
  if (!login || !password) throw new Error("FAFA_LOGIN / FAFA_PASSWORD env vars missing");

  console.log(`[FAFA] login start, URL: ${page.url()}`);

  const loginLink = await page.$("a[href*='login'], a[href*='signin'], a[href*='enter'], .login-btn, .btn-login").catch(() => null);
  if (loginLink) {
    await page.evaluate(el => el.click(), loginLink);
    await rand(1000, 1500);
  }

  await page.evaluate(({ l, p }) => {
    const fire = (el, val) => {
      el.focus(); el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const loginInput = document.querySelector("input[name='login']");
    const passInput = document.querySelector("input[name='pass1'], input[type='password'], input[name='password']");
    if (loginInput) fire(loginInput, l);
    if (passInput) fire(passInput, p);
  }, { l: login, p: password });

  await rand(800, 1200);

  const submitted = await page.evaluate(() => {
    const sbm = document.querySelector("input[name='sbm']");
    if (sbm) { sbm.click(); return "input[name=sbm].click()"; }
    const passInput = document.querySelector("input[name='pass1'], input[type='password']");
    if (passInput?.form) { passInput.form.submit(); return "passInput.form.submit()"; }
    return null;
  });
  console.log(`[FAFA] submit method: ${submitted}`);

  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await rand(2000, 3000);

  const afterUrl = page.url();
  console.log(`[FAFA] login done, URL: ${afterUrl}`);
  if (afterUrl.includes("/login")) {
    throw new Error("Login failed — redirected back to login page. Check credentials.");
  }
}

async function extractItems(page) {
  return page.evaluate(() => {
    const SEPS = ["→", "—", "–"];
    const JUNK = /выход|кабинет|справка|telegram|copyright|реклам|отмеченн|главная|мои\s*груз|мои\s*машин|найти\s*груз|найти\s*машин/i;

    function splitRoute(txt) {
      for (const sep of SEPS) {
        const idx = txt.indexOf(sep);
        if (idx >= 0) {
          const from = txt.substring(0, idx).trim();
          const to = txt.substring(idx + sep.length).trim().replace(/\s*-\s*\d+\s*км.*$/i, "").trim();
          return { from, to };
        }
      }
      return null;
    }

    const results = [];

    // Find all <a> tags whose text contains a route separator
    const routeLinks = Array.from(document.querySelectorAll("a")).filter(a => {
      const txt = a.textContent;
      return SEPS.some(s => txt.includes(s));
    });

    for (const link of routeLinks) {
      const route = splitRoute(link.textContent.trim());
      if (!route || !route.from || !route.to) continue;
      if (JUNK.test(route.from) || JUNK.test(route.to)) continue;
      if (route.from.length > 80 || route.to.length > 80) continue;

      // Walk up to the containing <tr>
      let row = link.parentElement;
      while (row && row.tagName !== "TR") row = row.parentElement;
      if (!row) continue;

      const cells = Array.from(row.querySelectorAll("td"));
      const time = cells[0]?.textContent?.trim().split("\n")[0] || "";

      // Truck type: look for type keywords in the link's parent cell text
      let trCell = link.parentElement;
      while (trCell && trCell.tagName !== "TD") trCell = trCell.parentElement;
      const cellLines = (trCell?.textContent || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
      const truck_type = cellLines.find(l => /тент|рефр|изот|борт|конт|цист|любая|открыт/i.test(l)) || cellLines[1] || "";

      // Weight and cargo
      let weight = "", cargo = "";
      for (const td of cells) {
        const txt = td.textContent || "";
        if (/\d+\s*т[^а-яa-z]/.test(txt) || /\d+\s*м[³3]/.test(txt)) {
          const lines = txt.trim().split("\n").map(s => s.trim()).filter(s => s && s.length < 60);
          weight = lines[0] || "";
          cargo = lines.find(l => l !== weight && !/^\d/.test(l) && !JUNK.test(l)) || "";
          break;
        }
      }

      results.push({ from: route.from, to: route.to, cargo, weight, truck_type, time });
    }

    // Deduplicate by from+to+time
    const seen = new Set();
    return results.filter(it => {
      const k = `${it.from}|${it.to}|${it.time}`.toLowerCase().replace(/\s/g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}
