import { chromium } from "playwright";

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

export function initFafa(bot, chatId) { _bot = bot; _chatId = chatId; }
export function isMonitoringActive() { return isRunning; }
export function getFilters() { return { ...filters }; }
export function setFilter(key, value) {
  if (key in filters) filters[key] = value?.trim() || null;
}
export function clearFilters() {
  filters.from = null; filters.to = null;
  filters.cargo = null; filters.truck_type = null;
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
  if (!hasFilters) return; // no filters → scrape all, local filter will match everything

  const submitted = await page.evaluate(({ from, to, truckType }) => {
    const fire = (el, val) => {
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    // Find inputs by label text
    const allLabels = Array.from(document.querySelectorAll("label, td, th"));
    const findInputNear = (labelText) => {
      for (const el of allLabels) {
        if (el.textContent.trim().includes(labelText)) {
          const next = el.nextElementSibling || el.parentElement?.nextElementSibling;
          const input = next?.querySelector("input") || next?.querySelector("select");
          if (input) return input;
          // Try sibling td
          const sibling = el.closest("td")?.nextElementSibling?.querySelector("input");
          if (sibling) return sibling;
        }
      }
      return null;
    };

    let filled = [];

    if (from) {
      const inp = document.querySelector("input[name='from'], input[name='from_city'], #from_city")
        || findInputNear("погрузки");
      if (inp) { fire(inp, from); filled.push("from=" + from); }
    }

    if (to) {
      const inp = document.querySelector("input[name='to'], input[name='to_city'], #to_city")
        || findInputNear("разгрузки");
      if (inp) { fire(inp, to); filled.push("to=" + to); }
    }

    if (truckType) {
      const sel = document.querySelector("select[name='car_type'], select");
      if (sel) {
        const opt = Array.from(sel.options).find(o =>
          o.text.toLowerCase().includes(truckType.toLowerCase())
        );
        if (opt) { sel.value = opt.value; filled.push("truck=" + truckType); }
      }
    }

    // Submit search form
    const btn = Array.from(document.querySelectorAll("input[type='submit'], button[type='submit']"))
      .find(b => /искать|найти|search/i.test(b.value + b.textContent));
    if (btn) { btn.click(); return "submitted: " + filled.join(", "); }

    return "no submit btn, filled: " + filled.join(", ");
  }, { from: filters.from, to: filters.to, truckType: filters.truck_type });

  console.log(`[FAFA] search form: ${submitted}`);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await rand(1500, 2500);
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
    const results = [];

    const rows = Array.from(document.querySelectorAll("tr")).filter(r => {
      const link = r.querySelector("a");
      return link && link.textContent.includes(" — ");
    });

    for (const row of rows.slice(0, 60)) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      const routeCell = cells.find(td => td.querySelector("a")?.textContent.includes(" — "));
      if (!routeCell) continue;

      const routeText = routeCell.querySelector("a")?.textContent?.trim() || "";
      const dashIdx = routeText.indexOf(" — ");
      const from = dashIdx >= 0 ? routeText.substring(0, dashIdx).trim() : "";
      const toRaw = dashIdx >= 0 ? routeText.substring(dashIdx + 3).trim() : "";
      const to = toRaw.replace(/\s*-\s*\d+\s*км.*$/i, "").trim();

      const time = cells[0]?.textContent?.trim().split("\n")[0] || "";

      // Truck type: first line of route cell below the link
      const routeCellLines = routeCell.textContent?.trim().split("\n").map(s => s.trim()).filter(Boolean) || [];
      const truck_type = routeCellLines[1] || ""; // e.g. "рефр. (зад)", "тент (зад)"

      // Weight + cargo
      let weight = "", cargo = "";
      for (const td of cells) {
        const txt = td.textContent || "";
        if (/\d+т\s*\/\s*\d+м³|\d+\s*т/.test(txt)) {
          const lines = txt.trim().split("\n").map(s => s.trim()).filter(Boolean);
          weight = lines[0] || "";
          cargo = lines[1] || "";
          break;
        }
      }

      if (from && to) results.push({ from, to, cargo, weight, truck_type, time });
    }

    return results;
  });
}
