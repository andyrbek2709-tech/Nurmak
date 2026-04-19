import { chromium } from "playwright";
import { loadBotSetting, saveBotSetting } from "./supabase.js";

const LOGIN_URL  = "https://id.ati.su";
const SEARCH_URL = "https://loads.ati.su/";
const CHECK_INTERVAL_MS      = 5 * 60 * 1000;
const NO_RESULTS_NOTIFY_MS   = 60 * 60 * 1000;

let _bot = null;

// Per-user state: chatId → { filters, seenKeys, isRunning, monitorTimer, lastNoResultsAt }
const users = new Map();

function emptyFilters() {
  return { from: null, to: null };
}

async function getOrInitUser(chatId) {
  const key = String(chatId);
  if (!users.has(key)) {
    const state = {
      filters: emptyFilters(),
      seenKeys: new Set(),
      isRunning: false,
      monitorTimer: null,
      lastNoResultsAt: 0,
    };
    users.set(key, state);
    try {
      const val = await loadBotSetting(`atisu_filters_${key}`);
      if (val) {
        const saved = JSON.parse(val);
        Object.assign(state.filters, saved);
        console.log(`[ATISU] filters loaded for ${key}:`, JSON.stringify(state.filters));
      }
    } catch (_) {}
  }
  return users.get(key);
}

export function initAtisu(bot) {
  _bot = bot;
}

export async function isAtisuMonitoringActive(chatId) {
  const u = await getOrInitUser(chatId);
  return u.isRunning;
}

export async function getAtisuFilters(chatId) {
  const u = await getOrInitUser(chatId);
  return { ...u.filters };
}

export async function setAtisuFilter(chatId, key, value) {
  const u = await getOrInitUser(chatId);
  if (key in u.filters) {
    u.filters[key] = value?.trim() || null;
    saveBotSetting(`atisu_filters_${chatId}`, JSON.stringify(u.filters)).catch(() => {});
  }
}

export async function clearAtisuFilters(chatId) {
  const u = await getOrInitUser(chatId);
  u.filters = emptyFilters();
  saveBotSetting(`atisu_filters_${chatId}`, JSON.stringify(u.filters)).catch(() => {});
}

export async function startAtisuMonitoring(chatId) {
  const u = await getOrInitUser(chatId);
  if (u.isRunning) return;
  u.isRunning = true;
  u.seenKeys.clear();
  u.lastNoResultsAt = Date.now();
  console.log(`[ATISU] monitoring started for ${chatId}`);
  await tick(chatId);
}

export async function stopAtisuMonitoring(chatId) {
  const u = users.get(String(chatId));
  if (!u) return;
  u.isRunning = false;
  if (u.monitorTimer) { clearTimeout(u.monitorTimer); u.monitorTimer = null; }
  u.seenKeys.clear();
  console.log(`[ATISU] monitoring stopped for ${chatId}`);
}

export async function runAtisuOnce(chatId) {
  const u = await getOrInitUser(chatId);
  console.log(`[ATISU] running one-time search for ${chatId}...`);
  try {
    const items = await scrape(u.filters);
    console.log(`[ATISU] one-time: fetched ${items.length} items`);
    const matched = items.filter(item => matchesFilters(item, u.filters));
    console.log(`[ATISU] one-time: matched ${matched.length} items`);
    return matched;
  } catch (err) {
    console.error("[ATISU] runOnce error:", err.message);
    throw err;
  }
}

// ─── Filtering ────────────────────────────────────────────────────────────────

const COUNTRY_ALIASES = {
  "россия": "ru", "казахстан": "kz", "беларусь": "by",
  "узбекистан": "uz", "кыргызстан": "kg", "киргизия": "kg",
  "таджикистан": "tj", "туркменистан": "tm", "азербайджан": "az",
  "грузия": "ge", "армения": "am", "китай": "cn",
};

function matchesFilters(item, filters) {
  const matches = (field, filterVal) => {
    if (!filterVal) return true;
    const val = (field || "").toLowerCase();
    const flt = filterVal.toLowerCase();
    if (val.includes(flt)) return true;
    const code = COUNTRY_ALIASES[flt];
    if (code && val.includes(code)) return true;
    return false;
  };
  if (!matches(item.from, filters.from)) return false;
  if (!matches(item.to,   filters.to))   return false;
  return true;
}

// ─── Tick / notify ────────────────────────────────────────────────────────────

function makeKey(item) {
  return `${item.from}|${item.to}|${item.cargo}|${item.date}`
    .toLowerCase().replace(/\s+/g, "");
}

async function tick(chatId) {
  const u = users.get(String(chatId));
  if (!u || !u.isRunning) return;
  try {
    const items = await scrape(u.filters);
    console.log(`[ATISU] fetched ${items.length} items for ${chatId}`);

    const fresh = items.filter(i => {
      const k = makeKey(i);
      return k.length > 3 && !u.seenKeys.has(k);
    });
    const matched = fresh.filter(item => matchesFilters(item, u.filters));

    for (const item of fresh) u.seenKeys.add(makeKey(item));

    if (matched.length > 0) {
      for (const item of matched) await notify(item, chatId, true);
      u.lastNoResultsAt = Date.now();
      console.log(`[ATISU] sent ${matched.length} notifications to ${chatId}`);
    } else if (Date.now() - u.lastNoResultsAt >= NO_RESULTS_NOTIFY_MS) {
      u.lastNoResultsAt = Date.now();
      await _bot.telegram.sendMessage(chatId, "🔍 ATI.SU: новых результатов нет").catch(e =>
        console.error("[ATISU] sendMessage error:", e.message)
      );
    }
  } catch (err) {
    console.error("[ATISU] tick error:", err.message);
  }
  if (u.isRunning) u.monitorTimer = setTimeout(() => tick(chatId), CHECK_INTERVAL_MS);
}

async function notify(item, chatId, isNew = false) {
  if (!_bot) return;
  const text = buildAtisuMessage(item, { isNew });
  await _bot.telegram.sendMessage(chatId, text).catch(e =>
    console.error("[ATISU] sendMessage error:", e.message)
  );
}

export function buildAtisuMessage(item, opts = {}) {
  const header = opts.isNew ? "🆕 Новое направление (ATI.SU)" : "🚛 Заявка ATI.SU";
  const distPart = item.distance ? ` (${item.distance})` : "";
  return [
    header,
    ``,
    `📍 ${item.from || "—"} → ${item.to || "—"}${distPart}`,
    `📦 ${item.cargo || "—"}`,
    `🚛 ${item.truck_type || "—"}`,
    `⚖ ${item.weight || "—"}`,
    item.price ? `💰 ${item.price}` : null,
    `🕒 ${item.date || "—"}`,
  ].filter(l => l !== null).join("\n");
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return delay(Math.floor(min + Math.random() * (max - min))); }

async function scrape(filters) {
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

    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await rand(1500, 2000);

    // Check if already logged in; if not, login
    const needsLogin = await page.evaluate(() =>
      !!document.querySelector("a[href*='login'], a[href*='signin'], [data-test='login-btn'], .login-button")
      || !document.cookie.includes("atiauth")
    );
    if (needsLogin) await doLogin(page);

    // Navigate to search page after login
    await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });
    await rand(1000, 1500);

    await fillSearchForm(page, filters);

    await rand(2000, 3000);
    console.log(`[ATISU] scraping URL: ${page.url()}, title: ${await page.title()}`);

    const items = await extractItems(page);
    items.slice(0, 3).forEach((it, i) =>
      console.log(`[ATISU] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" price="${it.price}"`)
    );
    return items;
  } finally {
    await browser.close();
  }
}

async function doLogin(page) {
  const login    = process.env.ATISU_LOGIN;
  const password = process.env.ATISU_PASSWORD;
  if (!login || !password) throw new Error("ATISU_LOGIN / ATISU_PASSWORD env vars missing");

  console.log(`[ATISU] logging in...`);

  await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 30000 });
  await rand(1000, 1500);

  // Fill login form — ATI.SU uses email/phone + password
  await page.evaluate(({ l, p }) => {
    const fire = (el, val) => {
      el.focus(); el.value = val;
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const loginEl = document.querySelector(
      "input[name='login'], input[name='email'], input[type='email'], input[placeholder*='Email'], input[placeholder*='email'], input[placeholder*='логин'], input[placeholder*='телефон']"
    );
    const passEl = document.querySelector(
      "input[name='password'], input[type='password']"
    );
    if (loginEl) fire(loginEl, l);
    if (passEl)  fire(passEl,  p);
  }, { l: login, p: password });

  await rand(500, 800);

  // Submit
  const submitted = await page.evaluate(() => {
    const btn = document.querySelector(
      "button[type='submit'], input[type='submit'], button.login-btn, [data-test='submit-btn']"
    );
    if (btn) { btn.click(); return btn.textContent?.trim() || "button.click()"; }
    const form = document.querySelector("form");
    if (form) { form.submit(); return "form.submit()"; }
    return null;
  });
  console.log(`[ATISU] login submit: ${submitted}`);

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await rand(2000, 3000);

  const afterUrl = page.url();
  console.log(`[ATISU] login done, URL: ${afterUrl}`);

  if (afterUrl.includes("login") || afterUrl.includes("id.ati.su")) {
    // Maybe need to find actual password field after entering login (step-by-step form)
    const passVisible = await page.$("input[type='password']");
    if (passVisible) {
      await page.evaluate(({ p }) => {
        const el = document.querySelector("input[type='password']");
        if (el) {
          el.focus(); el.value = p;
          el.dispatchEvent(new Event("input",  { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, { p: password });
      await rand(400, 600);
      await page.evaluate(() => {
        const btn = document.querySelector("button[type='submit'], input[type='submit']");
        if (btn) btn.click();
      });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await rand(1500, 2000);
      console.log(`[ATISU] login step-2 done, URL: ${page.url()}`);
    }
  }
}

async function fillSearchForm(page, filters) {
  if (!filters.from && !filters.to) return;
  console.log(`[ATISU] fillSearchForm: from="${filters.from}" to="${filters.to}"`);

  const typeAndSelect = async (selector, value) => {
    if (!value) return;
    try {
      await page.click(selector, { timeout: 5000 });
      await page.fill(selector, value);
      await rand(800, 1200);

      // Wait for autocomplete dropdown
      const dropdownSel = ".suggestions-list, .autocomplete-list, [class*='suggest'], [class*='dropdown'] li, [role='option'], [role='listbox'] li";
      await page.waitForSelector(dropdownSel, { timeout: 5000 });

      // Pick first suggestion
      await page.locator(dropdownSel).first().click({ timeout: 3000 });
      await rand(400, 600);
      console.log(`[ATISU] ${selector}: selected suggestion for "${value}"`);
    } catch (e) {
      console.log(`[ATISU] ${selector}: no autocomplete for "${value}" — using typed value`);
    }
  };

  // Try common selectors for from/to fields on loads.ati.su
  const fromSel = "input[placeholder*='Откуда'], input[placeholder*='откуда'], input[name*='from'], input[name*='cityFrom'], input[data-test*='from'], .from-input input";
  const toSel   = "input[placeholder*='Куда'], input[placeholder*='куда'], input[name*='to'], input[name*='cityTo'], input[data-test*='to'], .to-input input";

  if (filters.from) await typeAndSelect(fromSel, filters.from);
  if (filters.to)   await typeAndSelect(toSel,   filters.to);

  // Submit search
  const submitSel = "button[type='submit'], button.search-btn, [data-test='search-btn'], button:has-text('Найти'), button:has-text('Поиск')";
  try {
    await page.click(submitSel, { timeout: 5000 });
  } catch (_) {
    await page.keyboard.press("Enter");
  }
  console.log(`[ATISU] search submitted`);

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await rand(1500, 2000);
  console.log(`[ATISU] search done, URL: ${page.url()}`);
}

async function extractItems(page) {
  return page.evaluate(() => {
    const SEPS = ["→", "—", "–", "-"];
    const results = [];

    // ATI.SU loads page — try multiple possible card selectors
    const cardSelectors = [
      ".cargo-item", ".load-item", ".search-result",
      "[data-test='cargo-row']", "[data-test='load-row']",
      "tr.result-row", ".loads-list__item", "[class*='cargo-row']",
      "[class*='load-row']", "[class*='LoadItem']", "[class*='CargoItem']",
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }

    // Fallback: find route links with "→" separator
    if (cards.length === 0) {
      const routeLinks = Array.from(document.querySelectorAll("a, span, div")).filter(el => {
        const txt = el.textContent || "";
        return SEPS.some(s => txt.includes(s)) && txt.length < 100;
      });

      for (const link of routeLinks) {
        const txt = link.textContent.trim();
        let from = "", to = "", distance = "";
        for (const sep of SEPS) {
          const idx = txt.indexOf(sep);
          if (idx > 0) {
            from = txt.substring(0, idx).trim();
            const rest = txt.substring(idx + sep.length).trim();
            const distMatch = rest.match(/([\d\s]+\s*км)/i);
            distance = distMatch ? distMatch[1].trim() : "";
            to = rest.replace(/\s*[\d\s]+\s*км.*$/i, "").trim();
            break;
          }
        }
        if (!from || !to || from.length > 60 || to.length > 60) continue;

        // Try to get surrounding context
        let container = link.parentElement;
        for (let i = 0; i < 4; i++) {
          if (!container) break;
          const txt2 = container.innerText || "";
          if (txt2.length > 20 && txt2.length < 500) break;
          container = container.parentElement;
        }
        const ctx = (container?.innerText || "").trim();
        const lines = ctx.split("\n").map(s => s.trim()).filter(Boolean);

        const weightMatch = ctx.match(/(\d+[\d,.\s]*)\s*т[^а-яa-z]/i);
        const weight = weightMatch ? weightMatch[0].trim() : "";

        const priceMatch = ctx.match(/[\d\s.,]+\s*(руб|тнг|₽|тг)[.,\s]*(нал|карт|безнал)?/i);
        const price = priceMatch ? priceMatch[0].trim() : "";

        const truckTypes = ["тент", "реф", "изот", "борт", "конт", "цист", "любая", "открыт", "термос"];
        const truck_type = lines.find(l => truckTypes.some(t => l.toLowerCase().includes(t))) || "";

        const dateMatch = ctx.match(/\d{1,2}[./]\d{1,2}([./]\d{2,4})?/);
        const date = dateMatch ? dateMatch[0] : "";

        const cargo = lines.find(l =>
          l !== truck_type && l.length < 50 &&
          !/^\d/.test(l) &&
          !/(руб|тнг|км|нал|карт)/i.test(l) &&
          !l.includes(from) && !l.includes(to)
        ) || "";

        results.push({ from, to, distance, cargo, weight, truck_type, price, date });
      }

      // Deduplicate
      const seen = new Set();
      return results.filter(it => {
        const k = `${it.from}|${it.to}|${it.date}|${it.truck_type}`.toLowerCase().replace(/\s/g, "");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // Parse structured cards
    for (const card of cards) {
      const text = card.innerText || "";
      const lines = text.split("\n").map(s => s.trim()).filter(Boolean);

      let from = "", to = "", distance = "";
      const routeEl = card.querySelector("a, [class*='route'], [class*='direction']");
      const routeTxt = (routeEl?.innerText || lines[0] || "").trim();

      for (const sep of SEPS) {
        const idx = routeTxt.indexOf(sep);
        if (idx > 0) {
          from = routeTxt.substring(0, idx).trim();
          const rest = routeTxt.substring(idx + sep.length).trim();
          const distMatch = rest.match(/([\d\s]+\s*км)/i);
          distance = distMatch ? distMatch[1].trim() : "";
          to = rest.replace(/\s*[\d\s]+\s*км.*$/i, "").trim();
          break;
        }
      }
      if (!from || !to) continue;

      const weightMatch = text.match(/(\d+[\d,.\s]*)\s*т[^а-яa-z]/i);
      const weight = weightMatch ? weightMatch[0].trim() : "";

      const priceMatch = text.match(/[\d\s.,]+\s*(руб|тнг|₽|тг)[.,\s]*(нал|карт|безнал)?/i);
      const price = priceMatch ? priceMatch[0].trim() : "";

      const truckTypes = ["тент", "реф", "изот", "борт", "конт", "цист", "любая", "открыт", "термос"];
      const truck_type = lines.find(l => truckTypes.some(t => l.toLowerCase().includes(t))) || "";

      const dateMatch = text.match(/\d{1,2}[./]\d{1,2}([./]\d{2,4})?/);
      const date = dateMatch ? dateMatch[0] : "";

      const cargo = lines.find(l =>
        l !== truck_type && l.length < 50 &&
        !/^\d/.test(l) &&
        !/(руб|тнг|км|нал|карт)/i.test(l) &&
        !l.includes(from) && !l.includes(to)
      ) || "";

      results.push({ from, to, distance, cargo, weight, truck_type, price, date });
    }

    const seen = new Set();
    return results.filter(it => {
      const k = `${it.from}|${it.to}|${it.date}|${it.truck_type}`.toLowerCase().replace(/\s/g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}
