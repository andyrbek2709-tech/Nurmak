import { chromium } from "playwright";
import { loadBotSetting, saveBotSetting } from "./supabase.js";
import { scrapeAtisu } from "./atisu.js";
import { delay, rand } from "../utils/timing.js";

const FAFA_URL = "https://fa-fa.kz";
const SEARCH_URL = `${FAFA_URL}/search_load/`;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const NO_RESULTS_NOTIFY_MS = 60 * 60 * 1000;

let _bot = null;

// Per-user state: chatId → { filters, seenKeys, isRunning, monitorTimer }
const users = new Map();

function emptyFilters() {
  return { from: null, to: null, cargo: null, truck_type: null };
}

async function getOrInitUser(chatId) {
  const key = String(chatId);
  if (!users.has(key)) {
    const state = { filters: emptyFilters(), seenKeys: new Set(), isRunning: false, monitorTimer: null, lastNoResultsAt: 0 };
    users.set(key, state);
    try {
      const val = await loadBotSetting(`filters_${key}`);
      if (val) {
        const saved = JSON.parse(val);
        Object.assign(state.filters, saved);
        console.log(`[FAFA] filters loaded for ${key}:`, JSON.stringify(state.filters));
      }
    } catch (_) {}
  }
  return users.get(key);
}

export function initFafa(bot) {
  _bot = bot;
}

export async function isMonitoringActive(chatId) {
  const u = await getOrInitUser(chatId);
  return u.isRunning;
}

export async function getFilters(chatId) {
  const u = await getOrInitUser(chatId);
  return { ...u.filters };
}

export async function setFilter(chatId, key, value) {
  const u = await getOrInitUser(chatId);
  if (key in u.filters) {
    u.filters[key] = value?.trim() || null;
    saveBotSetting(`filters_${chatId}`, JSON.stringify(u.filters)).catch(() => {});
  }
}

export async function clearFilters(chatId) {
  const u = await getOrInitUser(chatId);
  u.filters = emptyFilters();
  saveBotSetting(`filters_${chatId}`, JSON.stringify(u.filters)).catch(() => {});
}

export async function startMonitoring(chatId) {
  const u = await getOrInitUser(chatId);
  if (u.isRunning) return;
  u.isRunning = true;
  u.seenKeys.clear();
  u.lastNoResultsAt = Date.now(); // первый hourly-сигнал придёт через час
  console.log(`[FAFA] monitoring started for ${chatId}`);
  await tick(chatId);
}

export async function stopMonitoring(chatId) {
  const u = users.get(String(chatId));
  if (!u) return;
  u.isRunning = false;
  if (u.monitorTimer) { clearTimeout(u.monitorTimer); u.monitorTimer = null; }
  u.seenKeys.clear();
  console.log(`[FAFA] monitoring stopped for ${chatId}`);
}

export async function runOnce(chatId) {
  const u = await getOrInitUser(chatId);
  console.log(`[FAFA] running one-time search for ${chatId}...`);
  try {
    const items = await scrape(u.filters);
    console.log(`[FAFA] one-time: fetched ${items.length} items`);
    const matched = items.filter(item => matchesFilters(item, u.filters));
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

function matchesFilters(item, filters) {
  const matches = (field, filterVal) => {
    if (!filterVal) return true;
    const val = (field || "").toLowerCase();
    const flt = filterVal.toLowerCase();

    // Full match
    if (val.includes(flt)) return true;

    // Handle "City, Country" format — try city part and country part separately
    const commaIdx = flt.indexOf(",");
    const cityPart    = commaIdx >= 0 ? flt.substring(0, commaIdx).trim() : flt;
    const countryPart = commaIdx >= 0 ? flt.substring(commaIdx + 1).trim() : flt;

    if (cityPart && val.includes(cityPart)) return true;

    const code = COUNTRY_ALIASES[countryPart];
    if (code && val.includes(code.toLowerCase())) return true;
    if (countryPart !== cityPart && val.includes(countryPart)) return true;

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
  return `${item.source || ""}|${item.from}|${item.to}|${item.cargo}|${item.time}`
    .toLowerCase().replace(/\s+/g, "");
}

async function tick(chatId) {
  const u = users.get(String(chatId));
  if (!u || !u.isRunning) return;
  try {
    const items = await scrape(u.filters);
    console.log(`[FAFA] fetched ${items.length} items for ${chatId}`);

    const freshWithKeys = items
      .map(i => [i, makeKey(i)])
      .filter(([, k]) => k.length > 3 && !u.seenKeys.has(k));
    const matched = freshWithKeys
      .filter(([item]) => matchesFilters(item, u.filters))
      .map(([item]) => item);

    for (const [, k] of freshWithKeys) {
      if (u.seenKeys.size >= 5000) u.seenKeys.clear();
      u.seenKeys.add(k);
    }

    if (matched.length > 0) {
      for (const item of matched) await notify(item, chatId, true);
      u.lastNoResultsAt = Date.now(); // сбрасываем счётчик — были новые результаты
      console.log(`[FAFA] sent ${matched.length} notifications to ${chatId}`);
    } else if (Date.now() - u.lastNoResultsAt >= NO_RESULTS_NOTIFY_MS) {
      u.lastNoResultsAt = Date.now();
      await _bot.telegram.sendMessage(chatId, "🔍 Новых результатов нет").catch(e =>
        console.error("[FAFA] sendMessage error:", e.message)
      );
    }
  } catch (err) {
    console.error("[FAFA] tick error:", err.message);
  }
  if (u.isRunning) u.monitorTimer = setTimeout(() => tick(chatId), CHECK_INTERVAL_MS);
}

async function notify(item, chatId, isNew = false) {
  if (!_bot) return;
  const text = buildMessage(item, { isNew });
  await _bot.telegram.sendMessage(chatId, text).catch(e =>
    console.error("[FAFA] sendMessage error:", e.message)
  );
}

export function buildMessage(item, opts = {}) {
  const site = item.source === "atisu" ? "ATI.SU" : "FA-FA.KZ";
  const header = opts.isNew ? `🆕 Новое направление (${site})` : `🚛 Заявка ${site}`;
  const distPart = item.distance ? ` (${item.distance})` : "";
  return [
    header,
    ``,
    `📍 ${item.from || "—"} → ${item.to || "—"}${distPart}`,
    `📦 ${item.cargo || "—"}`,
    `🚛 ${item.truck_type || "—"}`,
    `⚖ ${item.weight || "—"}`,
    item.price ? `💰 ${item.price}` : null,
    `🕒 ${item.time || "—"}`,
  ].filter(l => l !== null).join("\n");
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

async function scrape(filters) {
  const items = [];

  // Run sequentially to avoid launching two Chromium instances simultaneously (OOM risk)
  try {
    const fafaItems = await scrapeFafa(filters);
    items.push(...fafaItems.map(i => ({ ...i, source: "fafa" })));
  } catch (err) {
    console.error("[SCRAPE] fafa error:", err.message);
  }

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("scrapeAtisu timeout 120s")), 120000)
    );
    const atisuItems = await Promise.race([scrapeAtisu(filters), timeout]);
    items.push(...atisuItems.map(i => ({ ...i, source: "atisu" })));
  } catch (err) {
    console.error("[SCRAPE] atisu error:", err.message);
  }

  return items;
}

async function scrapeFafa(filters) {
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
    await fillSearchForm(page, filters);

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

async function fillSearchForm(page, filters) {
  const hasFilters = filters.from || filters.to || filters.truck_type;
  if (!hasFilters) return;

  console.log(`[FAFA] fillSearchForm: from="${filters.from}" to="${filters.to}"`);

  const typeAndPickSuggestion = async (inputId, value) => {
    await page.evaluate(() => {
      document.querySelectorAll('[class*="csr-"]').forEach(el => el.remove());
    });

    await page.evaluate(({ id, v }) => {
      const inp = document.getElementById(id);
      if (!inp) return;
      inp.focus();
      inp.value = v;
      inp.dispatchEvent(new Event("input",  { bubbles: true }));
      inp.dispatchEvent(new Event("keyup",  { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }, { id: inputId, v: value });

    try {
      await page.waitForSelector("div.av1", { timeout: 6000 });
    } catch (_) {
      console.log(`[FAFA] #${inputId}: no div.av1 for "${value}"`);
      return null;
    }

    const av1List = await page.evaluate(() =>
      Array.from(document.querySelectorAll("div.av1")).slice(0, 5).map(d => ({
        text: d.textContent.trim(),
        visible: !!d.offsetParent,
        attrs: Array.from(d.attributes).map(a => `${a.name}=${a.value}`).join("; "),
        html: d.outerHTML.slice(0, 300),
      }))
    );

    const visibleAv1 = av1List.find(d => d.visible);
    if (!visibleAv1) {
      console.log(`[FAFA] #${inputId}: no visible div.av1`);
      return null;
    }

    const picked = visibleAv1.text;

    // Try Playwright native click first (triggers site's JS event handlers)
    try {
      await page.locator("div.av1").filter({ hasText: picked.slice(0, 10) }).first().click({ timeout: 3000 });
    } catch (_) {
      // Fallback: MouseEvent dispatch
      await page.evaluate(() => {
        const div = Array.from(document.querySelectorAll("div.av1")).find(d => d.offsetParent);
        if (div) {
          div.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          div.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
          div.dispatchEvent(new MouseEvent("click",     { bubbles: true }));
        }
      });
    }

    await rand(500, 700);

    // If the city hidden field was NOT set by the click, extract ID from onclick and set manually
    const fieldName = inputId === "search1" ? "City[1]" : "city_end";
    const hiddenAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input")).map(el => ({ n: el.name, id: el.id, t: el.type, v: el.value }))
    );
    const citySet = hiddenAfter.some(f => f.n === fieldName && f.v);
    if (!citySet) {
      // Many autocompletes store the city ID in onclick="setCity(123,'Name')" or data-id="123"
      const onclickAttr = visibleAv1.attrs.match(/onclick=([^;]+)/)?.[1] || "";
      const dataIdMatch = visibleAv1.attrs.match(/data-id=(\d+)/);
      const onclickIdMatch = onclickAttr.match(/\d+/);
      const cityId = dataIdMatch?.[1] || onclickIdMatch?.[0] || null;
      if (cityId) {
        await page.evaluate(({ name, val }) => {
          let inp = document.querySelector(`input[name="${name}"]`);
          if (!inp) {
            inp = document.createElement("input");
            inp.type = "hidden"; inp.name = name;
            const form = document.querySelector("form");
            if (form) form.appendChild(inp);
          }
          inp.value = val;
        }, { name: fieldName, val: cityId });
        console.log(`[FAFA] #${inputId}: manually set ${fieldName}=${cityId}`);
      } else {
        console.log(`[FAFA] #${inputId}: WARNING — ${fieldName} not set, onclick="${onclickAttr}"`);
      }
    }

    console.log(`[FAFA] #${inputId} picked: "${picked}"`);
    await rand(300, 500);
    return picked;
  };

  // FA-FA autocomplete expects just the city/country name without ", Country" suffix
  const cityFrom = filters.from ? filters.from.split(",")[0].trim() : null;
  const cityTo   = filters.to   ? filters.to.split(",")[0].trim()   : null;
  if (cityFrom) await typeAndPickSuggestion("search1",  cityFrom);
  if (cityTo)   await typeAndPickSuggestion("search10", cityTo);

  // Truck type select
  if (filters.truck_type) {
    await page.evaluate((t) => {
      const sel = document.querySelector("select[name='car_type'], select");
      if (!sel) return;
      const opt = Array.from(sel.options).find(o => o.text.toLowerCase().includes(t.toLowerCase()));
      if (opt) sel.value = opt.value;
    }, filters.truck_type).catch(() => {});
  }

  // Submit — use load_search button (search for cargo, not trucks)
  await page.evaluate(() => {
    const btn = document.querySelector("input[name='load_search']");
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
          const rest = txt.substring(idx + sep.length).trim();
          const distMatch = rest.match(/-\s*([\d\s]+\s*км)/i);
          const distance = distMatch ? distMatch[1].replace(/\s+/g, " ").trim() : "";
          const to = rest.replace(/\s*-\s*[\d\s]+\s*км.*$/i, "").trim();
          return { from, to, distance };
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
      // Find the date cell by looking for a dd.mm date pattern (skip checkbox cells)
      const dateCell = cells.find(td => /\d{2}\.\d{2}/.test(td.innerText || ""));
      const time = dateCell?.innerText?.trim().split("\n")[0] || "";

      // Truck type: use innerText so <br> tags become newlines
      let trCell = link.parentElement;
      while (trCell && trCell.tagName !== "TD") trCell = trCell.parentElement;
      const cellLines = (trCell?.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
      const truck_type = cellLines.find(l => /тент|рефр|изот|борт|конт|цист|любая|открыт/i.test(l)) || cellLines[1] || "";

      // Price: look in dateCell lines for price pattern
      const dateCellLines = (dateCell?.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
      const price = dateCellLines.find(l => /руб\.|тнг\.|нал|карту/.test(l)) || "";

      // Weight and cargo — use innerText to preserve line breaks
      let weight = "", cargo = "";
      for (const td of cells) {
        const txt = td.innerText || "";
        if (/\d+\s*т[^а-яa-z]/.test(txt) || /\d+\s*м[³3]/.test(txt)) {
          const lines = txt.trim().split("\n").map(s => s.trim()).filter(s => s && s.length < 60);
          weight = lines[0] || "";
          cargo = lines.find(l => l !== weight && !/^\d/.test(l) && !JUNK.test(l)) || "";
          break;
        }
      }

      results.push({ from: route.from, to: route.to, distance: route.distance || "", cargo, weight, truck_type, time, price });
    }

    // Deduplicate by from+to+time+truck_type
    const seen = new Set();
    return results.filter(it => {
      const k = `${it.from}|${it.to}|${it.time}|${it.truck_type}`.toLowerCase().replace(/\s/g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}
