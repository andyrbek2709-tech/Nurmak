import { chromium } from "playwright";
import { loadBotSetting, saveBotSetting } from "./supabase.js";
import { scrapeAtisu } from "./atisu.js";
import { delay, rand } from "../utils/timing.js";
import { trackEvent } from "./controlTower.js";

const FAFA_URL = "https://fa-fa.kz";
const SEARCH_URL = `${FAFA_URL}/search_load/`;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const NO_RESULTS_NOTIFY_MS = 60 * 60 * 1000;

let _bot = null;

// Per-user state: chatId → { filters, seenKeys, isRunning, monitorTimer }
const users = new Map();

function emptyFilters() {
  return { from: null, to: null, truck_type: null, weight: null, volume: null };
}

async function getOrInitUser(chatId) {
  const key = String(chatId);
  if (!users.has(key)) {
    const state = { filters: { fafa: emptyFilters(), atisu: emptyFilters() }, seenKeys: new Set(), isRunning: false, monitorTimer: null, lastNoResultsAt: 0 };
    users.set(key, state);
    try {
      const val = await loadBotSetting(`filters_${key}`);
      if (val) {
        const saved = JSON.parse(val);
        // Migration: old format had from/to at top level
        if ("from" in saved || "to" in saved) {
          state.filters = { fafa: Object.assign(emptyFilters(), saved), atisu: emptyFilters() };
        } else {
          state.filters = {
            fafa:  Object.assign(emptyFilters(), saved.fafa  || {}),
            atisu: Object.assign(emptyFilters(), saved.atisu || {}),
          };
        }
        console.log(`[FAFA] filters loaded for ${key}:`, JSON.stringify(state.filters));
      }
    } catch (_) {}
  }
  return users.get(key);
}

export function initFafa(bot) {
  _bot = bot;
  restoreMonitoring();
}

// ─── Monitoring persistence ───────────────────────────────────────────────────

async function saveMonitorList(set) {
  await saveBotSetting("active_monitors", JSON.stringify([...set])).catch(() => {});
}

async function restoreMonitoring() {
  try {
    const raw = await loadBotSetting("active_monitors");
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!list.length) return;
    console.log(`[FAFA] restoring monitoring for ${list.length} users:`, list);
    // Stagger first ticks to avoid concurrent Chromium launches at boot (OOM risk on Railway)
    for (let i = 0; i < list.length; i++) {
      const chatId = String(list[i]);
      const u = await getOrInitUser(chatId);
      if (u.isRunning) continue;
      u.isRunning = true;
      u.seenKeys.clear();
      u.lastNoResultsAt = Date.now();
      const delayMs = 30000 + i * 60000;
      u.monitorTimer = setTimeout(() => tick(chatId), delayMs);
      console.log(`[FAFA] monitoring restored for ${chatId} (first check in ${delayMs / 1000}s)`);
    }
  } catch (err) {
    console.error("[FAFA] restoreMonitoring error:", err.message);
  }
}

export async function isMonitoringActive(chatId) {
  const u = await getOrInitUser(chatId);
  return u.isRunning;
}

export async function getFilters(chatId) {
  const u = await getOrInitUser(chatId);
  return { ...u.filters };
}

export async function setFilter(chatId, site, field, value) {
  const u = await getOrInitUser(chatId);
  if ((site === "fafa" || site === "atisu") && field in u.filters[site]) {
    u.filters[site][field] = value?.trim() || null;
    saveBotSetting(`filters_${chatId}`, JSON.stringify(u.filters)).catch(() => {});
  }
}

export async function clearFilters(chatId) {
  const u = await getOrInitUser(chatId);
  u.filters = { fafa: emptyFilters(), atisu: emptyFilters() };
  saveBotSetting(`filters_${chatId}`, JSON.stringify(u.filters)).catch(() => {});
}

export async function startMonitoring(chatId) {
  const u = await getOrInitUser(chatId);
  if (u.isRunning) return;
  u.isRunning = true;
  u.seenKeys.clear();
  u.lastNoResultsAt = Date.now();
  // Persist active monitor list
  const raw = await loadBotSetting("active_monitors").catch(() => null);
  const list = new Set(raw ? JSON.parse(raw) : []);
  list.add(String(chatId));
  await saveMonitorList(list);
  console.log(`[FAFA] monitoring started for ${chatId}`);
  await tick(chatId);
}

export async function stopMonitoring(chatId) {
  const u = users.get(String(chatId));
  if (!u) return;
  u.isRunning = false;
  if (u.monitorTimer) { clearTimeout(u.monitorTimer); u.monitorTimer = null; }
  u.seenKeys.clear();
  // Remove from persisted list
  const raw = await loadBotSetting("active_monitors").catch(() => null);
  const list = new Set(raw ? JSON.parse(raw) : []);
  list.delete(String(chatId));
  await saveMonitorList(list);
  console.log(`[FAFA] monitoring stopped for ${chatId}`);
}

export async function runOnce(chatId) {
  const u = await getOrInitUser(chatId);
  console.log(`[FAFA] running one-time search for ${chatId}...`);
  try {
    const items = await scrape(u.filters.fafa, u.filters.atisu);
    console.log(`[FAFA] one-time: fetched ${items.length} items`);
    const matched = items.filter(item => {
      const f = item.source === "fafa" ? u.filters.fafa : u.filters.atisu;
      return matchesFilters(item, f);
    });
    console.log(`[FAFA] one-time: matched ${matched.length} items`);

    // [CT] track each found order
    for (const item of matched) {
      trackEvent("order_found", {
        chatId,
        from: item.from,
        to: item.to,
        cargo: item.cargo,
        truck_type: item.truck_type,
        price: item.price,
        source: item.source || "search",
        isMonitor: false,
      });
    }

    return matched;
  } catch (err) {
    console.error("[FAFA] runOnce error:", err.message);
    throw err;
  }
}

// ─── Filtering ────────────────────────────────────────────────────────────────

const COUNTRY_ALIASES = {
  "россия": "RU", "казахстан": "KZ", "беларусь": "BY", "беларусия": "BY",
  "узбекистан": "UZ", "кыргызстан": "KG", "киргизия": "KG",
  "таджикистан": "TJ", "туркменистан": "TM", "азербайджан": "AZ",
  "грузия": "GE", "армения": "AM", "китай": "CN",
};

function parseRange(str) {
  if (!str) return { min: null, max: null };
  const dash = str.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (dash) return { min: parseFloat(dash[1]), max: parseFloat(dash[2]) };
  const single = str.match(/(\d+(?:\.\d+)?)/);
  // Single number = maximum: "5" means "up to 5"
  return single ? { min: null, max: parseFloat(single[1]) } : { min: null, max: null };
}

function parseItemWeight(weightStr) {
  if (!weightStr) return { tons: null, m3: null };
  const t = weightStr.match(/(\d+(?:\.\d+)?)\s*т/);
  const m = weightStr.match(/(\d+(?:\.\d+)?)\s*м/);
  return { tons: t ? parseFloat(t[1]) : null, m3: m ? parseFloat(m[1]) : null };
}

function matchesFilters(item, filters) {
  const matches = (field, filterVal) => {
    if (!filterVal) return true;
    const val = (field || "").toLowerCase();
    const flt = filterVal.toLowerCase();

    if (val.includes(flt)) return true;

    const commaIdx = flt.indexOf(",");
    const cityPart    = commaIdx >= 0 ? flt.substring(0, commaIdx).trim() : flt;
    const countryPart = commaIdx >= 0 ? flt.substring(commaIdx + 1).trim()  : flt;

    if (cityPart && val.includes(cityPart)) return true;

    const code = COUNTRY_ALIASES[countryPart];
    if (code && val.includes(code.toLowerCase())) return true;
    if (countryPart !== cityPart && val.includes(countryPart)) return true;

    return false;
  };
  if (!matches(item.from, filters.from)) return false;
  if (!matches(item.to, filters.to)) return false;
  if (filters.truck_type) {
    const types = filters.truck_type.split(",").map(t => t.trim()).filter(Boolean);
    if (types.length > 0 && !types.some(t => matches(item.truck_type, t))) return false;
  }
  if (filters.weight || filters.volume) {
    const { tons, m3 } = parseItemWeight(item.weight);
    if (filters.weight && tons !== null) {
      const { min, max } = parseRange(filters.weight);
      if (min !== null && tons < min) return false;
      if (max !== null && tons > max) return false;
    }
    if (filters.volume && m3 !== null) {
      const { min, max } = parseRange(filters.volume);
      if (min !== null && m3 < min) return false;
      if (max !== null && m3 > max) return false;
    }
  }
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
    const items = await scrape(u.filters.fafa, u.filters.atisu);
    console.log(`[FAFA] fetched ${items.length} items for ${chatId}`);

    const freshWithKeys = items
      .map(i => [i, makeKey(i)])
      .filter(([, k]) => k.length > 3 && !u.seenKeys.has(k));
    const matched = freshWithKeys
      .filter(([item]) => {
        const f = item.source === "fafa" ? u.filters.fafa : u.filters.atisu;
        return matchesFilters(item, f);
      })
      .map(([item]) => item);

    for (const [, k] of freshWithKeys) {
      if (u.seenKeys.size >= 5000) u.seenKeys.clear();
      u.seenKeys.add(k);
    }

    if (matched.length > 0) {
      for (const item of matched) {
        await notify(item, chatId, true);

        // [CT] track each new cargo found during monitoring
        trackEvent("order_found", {
          chatId,
          from: item.from,
          to: item.to,
          cargo: item.cargo,
          truck_type: item.truck_type,
          price: item.price,
          source: item.source || "monitor",
          isMonitor: true,
        });
      }
      u.lastNoResultsAt = Date.now();
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
  const header = opts.isNew ? `🆕 Новое направление (\n\t${site})` : ` —🚛 Заявка ${site}`;
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

// Global mutex: only one scrape at a time across all users (Chromium is RAM-heavy)
let scrapeChain = Promise.resolve();
async function scrape(fafaFilters, atisuFilters) {
  const prev = scrapeChain;
  let release;
  scrapeChain = new Promise(r => { release = r; });
  try {
    await prev.catch(() => {});
    return await scrapeInternal(fafaFilters, atisuFilters);
  } finally {
    release();
  }
}

async function scrapeInternal(fafaFilters, atisuFilters) {
  const items = [];

  // Run sequentially to avoid launching two Chromium instances simultaneously (OOM risk)
  try {
    const fafaItems = await scrapeFafa(fafaFilters);
    items.push(...fafaItems.map(i => ({ ...i, source: "fafa" })));
  } catch (err) {
    console.error("[SCRAPE] fafa error:", err.message);
  }

  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("scrapeAtisu timeout 120s")), 120000)
    );
    const atisuItems = await Promise.race([scrapeAtisu(atisuFilters), timeout]);
    items.push(...atisuItems.map(i => ({ ...i, source: "atisu" })));
  } catch (err) {
    console.error("[SCRAPE] atisu error:", err.message);
  }

  return items;
}

async function scrapeFafa(filters) {
  // Hard 90s cap — protects the global mutex so ATI.SU always gets its turn
  const hardTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("scrapeFafa hard timeout 90s")), 90000)
  );
  return Promise.race([_scrapeFafa(filters), hardTimeout]);
}

async function _scrapeFafa(filters) {
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

    // Go to search page directly — it will show login form if not authenticated
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await rand(1500, 2000);

    // Check if login form is visible (indicates we're not authenticated)
    const hasLoginForm = await page.$("input[name='login'], input[name='pass1']").catch(() => null);
    if (hasLoginForm && process.env.FAFA_LOGIN && process.env.FAFA_PASSWORD) {
      try {
        await doLogin(page);
        console.log("[FAFA] login successful");
      }
      catch (e) {
        console.log(`[FAFA] login failed, continuing anyway: ${e.message}`);
      }
    } else if (hasLoginForm) {
      console.log("[FAFA] login form present but no credentials — searching anonymously");
    } else {
      console.log("[FAFA] already authenticated or no login form detected");
    }

    await fillSearchForm(page, filters);

    await rand(2000, 3000);
    console.log(`[FAFA] scraping URL: ${page.url()}, title: ${await page.title()}`);

    const items = await extractItems(page);
    console.log(`[FAFA] extractItems: ${items.length} items`);
    items.slice(0, 5).forEach((it, i) =>
      console.log(`[FAFA] item[${i}]: from="${it.from}" to="${it.to}" truck="${it.truck_type}"`)
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
      }))
    );

    const visibleAv1 = av1List.find(d => d.visible);
    if (!visibleAv1) {
      console.log(`[FAFA] #${inputId}: no visible div.av1`);
      return null;
    }

    const picked = visibleAv1.text;

    try {
      await page.locator("div.av1").filter({ hasText: picked.slice(0, 10) }).first().click({ timeout: 3000 });
    } catch (_) {
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

    const fieldName = inputId === "search1" ? "City[1]" : "city_end";
    const hiddenAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input")).map(el => ({ n: el.name, v: el.value }))
    );
    const citySet = hiddenAfter.some(f => f.n === fieldName && f.v);
    if (!citySet) {
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

  // FA-FA.KZ accepts plain text in both fields (city or country) — no need to skip countries.
  // Server filters by the typed text directly, e.g. city_end="Россия" → routes Актау→RU only.
  const cityFrom = filters.from ? filters.from.split(",")[0].trim() : null;
  const cityTo   = filters.to   ? filters.to.split(",")[0].trim()   : null;
  if (cityFrom) await typeAndPickSuggestion("search1",  cityFrom);
  if (cityTo)   await typeAndPickSuggestion("search10", cityTo);

  if (filters.truck_type) {
    await page.evaluate((t) => {
      const sel = document.querySelector("select[name='car_type'], select");
      if (!sel) return;
      const opt = Array.from(sel.options).find(o => o.text.toLowerCase().includes(t.toLowerCase()));
      if (opt) sel.value = opt.value;
    }, filters.truck_type).catch(() => {});
  }

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

  console.log(`[FAFA] login start, URL: ${page.url()}, login: ${login}`);

  // Use Playwright's native fill methods (more reliable than manual event dispatch)
  const loginInput = page.locator("input[name='login']");
  const passInput = page.locator("input[name='pass1']");

  try {
    await loginInput.waitFor({ timeout: 5000 });
    await loginInput.fill(login);
    console.log("[FAFA] login field filled");
  } catch (e) {
    throw new Error(`Login input not found: ${e.message}`);
  }

  try {
    await passInput.waitFor({ timeout: 5000 });
    await passInput.fill(password);
    console.log("[FAFA] password field filled");
  } catch (e) {
    throw new Error(`Password input not found: ${e.message}`);
  }

  await rand(500, 800);

  // Submit form by clicking the submit button
  const submitBtn = page.locator("input[name='sbm']");
  try {
    await submitBtn.waitFor({ timeout: 3000 });
    await submitBtn.click();
    console.log("[FAFA] submit button clicked");
  } catch (e) {
    throw new Error(`Submit button not found: ${e.message}`);
  }

  // Wait for page to load after login
  await Promise.race([
    page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
    page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {}),
  ]);
  await rand(1000, 2000);

  const afterUrl = page.url();
  console.log(`[FAFA] login done, URL: ${afterUrl}`);

  // Check if we got an error message on the page
  const errorMsg = await page.locator("body").innerText().catch(() => "");
  if (errorMsg.includes("неправильный") || errorMsg.includes("ошибк") || afterUrl.includes("/login")) {
    throw new Error("Login failed — credentials rejected or still on login page");
  }
}

async function extractItems(page) {
  return page.evaluate(() => {
    const SEPS = ["→", "–", "—"];
    const JUNK = /выход|кабинет|справка|telegram|copyright|реклам|отмечен|главная|мои\s*груз|мои\s*маш|найти\s*груз|найти\s*маш/i;

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

    const routeLinks = Array.from(document.querySelectorAll("a")).filter(a => {
      const txt = a.textContent;
      return SEPS.some(s => txt.includes(s));
    });

    for (const link of routeLinks) {
      const route = splitRoute(link.textContent.trim());
      if (!route || !route.from || !route.to) continue;
      if (JUNK.test(route.from) || JUNK.test(route.to)) continue;
      if (route.from.length > 80 || route.to.length > 80) continue;

      let row = link.parentElement;
      while (row && row.tagName !== "TR") row = row.parentElement;
      if (!row) continue;

      const cells = Array.from(row.querySelectorAll("td"));
      const dateCell = cells.find(td => /\d{2}\.\d{2}/.test(td.innerText || ""));
      const time = dateCell?.innerText?.trim().split("\n")[0] || "";

      let trCell = link.parentElement;
      while (trCell && trCell.tagName !== "TD") trCell = trCell.parentElement;
      const cellLines = (trCell?.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
      const truck_type = cellLines.find(l => /тент|рефр|изот|борт|Шонт|цист|гюль|отк/i.test(l)) || cellLines[1] || "";

      const dateCellLines = (dateCell?.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean);
      const price = dateCellLines.find(l => /руб|тенге|карт|нал/i.test(l)) || "";

      let weight = "", cargo = "";
      for (const td of cells) {
        const txt = td.innerText || "";
        if (/\d+\s*т[^а-я]/i.test(txt) || /\d+\s*м[³3]/.test(txt)) {
          const lines = txt.trim().split("\n").map(s => s.trim()).filter(s => s && s.length < 60);
          weight = lines[0] || "";
          cargo = lines.find(l => l !== weight && !/^\d/.test(l) && !JUNK.test(l)) || "";
          break;
        }
      }

      results.push({ from: route.from, to: route.to, distance: route.distance || "", cargo, weight, truck_type, time, price });
    }

    const seen = new Set();
    return results.filter(it => {
      const k = `${it.from}|${it.to}|${it.time}|${it.truck_type}`.toLowerCase().replace(/\s /g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}
