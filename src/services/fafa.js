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
  if (!hasFilters) return;

  // DIAGNOSTIC: dump all form inputs to understand page structure
  const formInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input, select")).map(el => ({
      tag: el.tagName, name: el.name, type: el.type,
      id: el.id, placeholder: el.placeholder, value: el.value,
    }))
  );
  console.log("[FAFA] form inputs:", JSON.stringify(formInputs));

  const fillWithAutocomplete = async (label, value) => {
    // Find the actual input next to the label td
    const inputInfo = await page.evaluate((lbl) => {
      const tds = Array.from(document.querySelectorAll("td"));
      const labelTd = tds.find(td => td.textContent.trim().startsWith(lbl));
      if (!labelTd) return null;
      const sibling = labelTd.nextElementSibling;
      const inp = sibling?.querySelector("input") || sibling?.querySelector("select");
      if (!inp) return null;
      return { name: inp.name, id: inp.id, type: inp.type };
    }, label);
    console.log(`[FAFA] input for "${label}":`, JSON.stringify(inputInfo));

    // Build selector for the target input
    let inputSel = null;
    if (inputInfo?.name) inputSel = `input[name="${inputInfo.name}"]`;
    else if (inputInfo?.id) inputSel = `#${inputInfo.id}`;

    if (inputSel) {
      try {
        await page.click(inputSel, { timeout: 3000 });
        await page.fill(inputSel, "");
        await page.type(inputSel, value, { delay: 80 });
        console.log(`[FAFA] typed "${value}" into ${inputSel}`);
      } catch (e) {
        console.log(`[FAFA] type failed for ${inputSel}: ${e.message}`);
        inputSel = null;
      }
    }

    if (!inputSel) {
      // Fallback: fill first empty visible text input
      await page.evaluate((v) => {
        const inp = Array.from(document.querySelectorAll("input[type='text']"))
          .find(el => !el.value && el.offsetParent);
        if (inp) {
          inp.focus(); inp.value = v;
          ["input", "keyup", "change"].forEach(ev =>
            inp.dispatchEvent(new Event(ev, { bubbles: true }))
          );
        }
      }, value);
      console.log(`[FAFA] fallback fill "${value}"`);
    }

    await rand(2000, 2500); // wait for autocomplete dropdown

    // DIAGNOSTIC: what visible elements contain our text after typing?
    const domInfo = await page.evaluate((v) => {
      const found = [];
      for (const el of document.querySelectorAll("*")) {
        if (!el.offsetParent) continue;
        if (el.children.length > 0) continue;
        const txt = (el.textContent || "").trim();
        if (txt && txt.toLowerCase().includes(v.toLowerCase()) && txt.length < 120) {
          found.push({ tag: el.tagName, cls: (el.className || "").substring(0, 50),
            name: el.getAttribute("name"), id: el.id,
            val: el.value, text: txt.substring(0, 80) });
        }
      }
      return found.slice(0, 10);
    }, value);
    console.log(`[FAFA] DOM after typing "${value}":`, JSON.stringify(domInfo));

    // Click first visible suggestion — fa-fa.kz uses div.av1
    const suggClicked = await page.evaluate((v) => {
      const selectors = [
        "div.av1",
        "ul.ui-autocomplete li",
        ".autocomplete-suggestion",
        ".suggestions li", ".suggestions div",
        "[class*='autocomplete'] li", "[class*='autocomplete'] div",
        "[class*='suggest'] li", "[class*='suggest'] div",
        "div.dropdown-menu li",
        "input[name='load_search']",
      ];
      for (const sel of selectors) {
        const items = Array.from(document.querySelectorAll(sel))
          .filter(el => el.offsetParent);
        if (items.length > 0) {
          items[0].click();
          return `${sel} -> "${(items[0].textContent || items[0].value || "").trim().substring(0, 60)}"`;
        }
      }
      return null;
    });
    console.log(`[FAFA] suggestion click: ${suggClicked}`);
    await rand(800, 1200);
  };

  if (filters.from) await fillWithAutocomplete("Место погрузки", filters.from);
  if (filters.to) await fillWithAutocomplete("Место разгрузки", filters.to);

  // city_end is often hidden — set via JS directly as well
  if (filters.to) {
    await page.evaluate((v) => {
      const inp = document.querySelector("input[name='city_end']");
      if (inp) {
        inp.value = v;
        ["input", "change"].forEach(ev => inp.dispatchEvent(new Event(ev, { bubbles: true })));
      }
    }, filters.to);
    console.log(`[FAFA] city_end set via JS: "${filters.to}"`);
  }

  // Select truck type via select element
  if (filters.truck_type) {
    await page.evaluate((truckType) => {
      const sel = document.querySelector("select[name='car_type'], select");
      if (!sel) return;
      const opt = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes(truckType.toLowerCase())
      );
      if (opt) sel.value = opt.value;
    }, filters.truck_type).catch(() => {});
  }

  // DIAGNOSTIC: what does the form look like before submit?
  const beforeSubmit = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input[type='text'], input[type='hidden'], select"))
      .filter(el => el.name)
      .map(el => ({ name: el.name, value: el.value }))
  );
  console.log("[FAFA] form state before submit:", JSON.stringify(beforeSubmit));

  // Submit search
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector("input[name='car_search']");
    if (btn) { btn.click(); return `car_search clicked, value="${btn.value}"`; }
    const btn2 = document.querySelector("input[type='submit'], button[type='submit']");
    if (btn2) { btn2.click(); return `submit btn clicked: "${btn2.value || btn2.textContent}"`; }
    return null;
  });
  console.log(`[FAFA] search submit: ${clicked}`);

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  try {
    await page.waitForSelector("tr td a", { timeout: 10000 });
  } catch (_) {
    console.log("[FAFA] waitForSelector tr td a timed out — proceeding anyway");
  }
  await rand(800, 1200);

  // DIAGNOSTIC: what rows/links exist after submit?
  const afterSubmit = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a")).filter(a => a.textContent.includes("—"));
    const rows = document.querySelectorAll("tr");
    const html = document.body.innerHTML.substring(0, 1500);
    return { rowCount: rows.length, dashLinks: links.slice(0, 5).map(a => a.textContent.trim()), html };
  });
  console.log(`[FAFA] after submit: rows=${afterSubmit.rowCount}, dashLinks=${JSON.stringify(afterSubmit.dashLinks)}`);
  console.log("[FAFA] page HTML snippet:", afterSubmit.html);
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
  // Dump first result rows to understand HTML structure
  const diagnostic = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr"));
    const sample = rows.slice(0, 8).map(r => r.outerHTML.substring(0, 500));
    const links = Array.from(document.querySelectorAll("a"))
      .filter(a => a.textContent.trim().length > 2)
      .slice(0, 20)
      .map(a => a.textContent.trim().substring(0, 80));
    return { rowCount: rows.length, sample, links };
  });
  console.log("[FAFA] row sample:", JSON.stringify(diagnostic.sample).substring(0, 3000));
  console.log("[FAFA] all links:", JSON.stringify(diagnostic.links));

  return page.evaluate(() => {
    const results = [];
    const SEPS = ["—", "→", " - ", " – "];

    function hasSep(txt) { return SEPS.some(s => txt.includes(s)); }
    function splitBySep(txt) {
      for (const sep of SEPS) {
        const idx = txt.indexOf(sep);
        if (idx >= 0) return [txt.substring(0, idx).trim(), txt.substring(idx + sep.length).trim(), sep];
      }
      return [txt, "", ""];
    }

    const rows = Array.from(document.querySelectorAll("tr")).filter(r => {
      const links = r.querySelectorAll("a");
      if (!links.length) return false;
      // Accept if any link text has a separator OR if row has 2+ city links
      for (const a of links) {
        if (hasSep(a.textContent)) return true;
      }
      // Also accept rows with 2+ non-empty links (separate from/to cells)
      const nonEmpty = Array.from(links).filter(a => a.textContent.trim().length > 2);
      return nonEmpty.length >= 2;
    });

    for (const row of rows.slice(0, 80)) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      let from = "", to = "", truck_type = "", weight = "", cargo = "", time = "";

      // Try: single link with separator "from — to"
      const routeCell = cells.find(td => {
        const a = td.querySelector("a");
        return a && hasSep(a.textContent);
      });

      if (routeCell) {
        const routeText = routeCell.querySelector("a").textContent.trim();
        const [f, t] = splitBySep(routeText);
        from = f;
        to = t.replace(/\s*-\s*\d+\s*км.*$/i, "").trim();
        const lines = routeCell.textContent.trim().split("\n").map(s => s.trim()).filter(Boolean);
        truck_type = lines[1] || "";
      } else {
        // Try: from and to are in separate links / tds
        const cityLinks = Array.from(row.querySelectorAll("a"))
          .filter(a => a.textContent.trim().length > 2);
        if (cityLinks.length >= 2) {
          from = cityLinks[0].textContent.trim();
          to = cityLinks[1].textContent.trim().replace(/\s*-\s*\d+\s*км.*$/i, "").trim();
        } else if (cityLinks.length === 1) {
          from = cityLinks[0].textContent.trim();
        }
      }

      time = cells[0]?.textContent?.trim().split("\n")[0] || "";

      for (const td of cells) {
        const txt = td.textContent || "";
        if (/\d+\s*т/.test(txt) || /\d+\s*м[³3]/.test(txt)) {
          const lines = txt.trim().split("\n").map(s => s.trim()).filter(Boolean);
          weight = lines[0] || "";
          cargo = lines[1] || "";
          break;
        }
      }

      if (from && from.length > 1) results.push({ from, to, cargo, weight, truck_type, time });
    }

    // Deduplicate
    const seen = new Set();
    return results.filter(it => {
      const k = `${it.from}|${it.to}`.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}
