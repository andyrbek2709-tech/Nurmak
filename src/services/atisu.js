import { chromium } from "playwright";

const LOGIN_URL  = "https://id.ati.su";
const SEARCH_URL = "https://loads.ati.su/";

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return delay(Math.floor(min + Math.random() * (max - min))); }

export async function scrapeAtisu(filters) {
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

    // Check if already logged in
    const needsLogin = await page.evaluate(() =>
      !!document.querySelector("a[href*='login'], a[href*='signin'], [data-test='login-btn']")
      || !document.cookie.includes("atiauth")
    );
    if (needsLogin) await doLogin(page);

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

  await page.evaluate(({ l, p }) => {
    const fire = (el, val) => {
      el.focus(); el.value = val;
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const loginEl = document.querySelector(
      "input[name='login'], input[name='email'], input[type='email'], input[placeholder*='Email'], input[placeholder*='логин'], input[placeholder*='телефон']"
    );
    const passEl = document.querySelector("input[name='password'], input[type='password']");
    if (loginEl) fire(loginEl, l);
    if (passEl)  fire(passEl,  p);
  }, { l: login, p: password });

  await rand(500, 800);

  const submitted = await page.evaluate(() => {
    const btn = document.querySelector("button[type='submit'], input[type='submit'], [data-test='submit-btn']");
    if (btn) { btn.click(); return btn.textContent?.trim() || "btn.click()"; }
    const form = document.querySelector("form");
    if (form) { form.submit(); return "form.submit()"; }
    return null;
  });
  console.log(`[ATISU] login submit: ${submitted}`);

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await rand(2000, 3000);

  const afterUrl = page.url();
  console.log(`[ATISU] login done, URL: ${afterUrl}`);

  // Step-2 form (email first, then password on next screen)
  if (afterUrl.includes("id.ati.su")) {
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

  // Dump all visible inputs for diagnostic
  const allInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input")).slice(0, 20).map(el => ({
      placeholder: el.placeholder, name: el.name, id: el.id, type: el.type,
      cls: el.className.slice(0, 60),
    }))
  );
  console.log(`[ATISU] inputs on page:`, JSON.stringify(allInputs));

  // Fill a React-controlled input: use native setter so React picks up the change,
  // then type chars one-by-one to trigger autocomplete suggestions.
  const fillReactInput = async (label, selectorList, value) => {
    if (!value) return;

    // Try each selector until one matches a visible element
    let handle = null;
    let matchedSel = null;
    for (const sel of selectorList) {
      try {
        handle = await page.waitForSelector(sel, { timeout: 3000, state: "visible" });
        matchedSel = sel;
        break;
      } catch (_) {}
    }
    if (!handle) {
      console.log(`[ATISU] ${label}: no input found with selectors:`, selectorList);
      return;
    }
    console.log(`[ATISU] ${label}: matched selector "${matchedSel}"`);

    // Clear + set value via React native-setter trick
    await page.evaluate((el) => {
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeSetter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, handle);
    await rand(200, 300);

    // Type char by char — most reliable way to trigger React autocomplete
    await page.evaluate((el) => el.focus(), handle);
    await page.keyboard.type(value, { delay: 80 });
    await rand(1000, 1500);

    // Wait for any dropdown
    const dropSelectors = [
      "[role='option']",
      "[role='listbox'] li",
      "[role='listbox'] [role='option']",
      "ul[class*='suggest'] li",
      "ul[class*='dropdown'] li",
      "[class*='Suggest'] li",
      "[class*='suggest'] li",
      "[class*='autocomplete'] li",
      "[class*='Autocomplete'] li",
      "li[class*='item']",
    ];
    let picked = false;
    for (const dSel of dropSelectors) {
      try {
        await page.waitForSelector(dSel, { timeout: 3000 });
        const items = await page.evaluate((sel) =>
          Array.from(document.querySelectorAll(sel)).slice(0, 5).map(el => ({
            text: el.textContent?.trim(), visible: !!el.offsetParent,
          }))
        , dSel);
        console.log(`[ATISU] ${label}: dropdown "${dSel}":`, JSON.stringify(items));
        const visibleItem = await page.locator(dSel).filter({ hasText: /./ }).first();
        if (await visibleItem.isVisible()) {
          await visibleItem.click({ timeout: 3000 });
          console.log(`[ATISU] ${label}: clicked first dropdown item`);
          picked = true;
          break;
        }
      } catch (_) {}
    }
    if (!picked) console.log(`[ATISU] ${label}: no dropdown — using typed value`);
    await rand(400, 600);
  };

  const fromSelectors = [
    "input[placeholder*='Откуда']", "input[placeholder*='откуда']",
    "input[placeholder*='город отправ']", "input[placeholder*='Город отправ']",
    "input[name*='from']", "input[name*='cityFrom']", "input[name*='departure']",
    ".from-input input", "[class*='from'] input", "[class*='From'] input",
  ];
  const toSelectors = [
    "input[placeholder*='Куда']", "input[placeholder*='куда']",
    "input[placeholder*='город назнач']", "input[placeholder*='Город назнач']",
    "input[name*='to']", "input[name*='cityTo']", "input[name*='destination']",
    ".to-input input", "[class*='to'] input", "[class*='To'] input",
  ];

  if (filters.from) await fillReactInput("from", fromSelectors, filters.from);
  if (filters.to)   await fillReactInput("to",   toSelectors,   filters.to);

  // Submit — try button selectors, then Enter
  const submitSelectors = [
    "button[type='submit']", "[data-test='search-btn']", "button.search-btn",
    "button[class*='search']", "button[class*='Search']",
    "[class*='submit']", "[class*='Submit']",
  ];
  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      await page.click(sel, { timeout: 3000 });
      console.log(`[ATISU] search submitted via "${sel}"`);
      submitted = true;
      break;
    } catch (_) {}
  }
  if (!submitted) {
    await page.keyboard.press("Enter");
    console.log(`[ATISU] search submitted via Enter`);
  }

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await rand(2000, 3000);
  console.log(`[ATISU] search done, URL: ${page.url()}`);

  // Dump page body snippet for debugging
  const bodySnip = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log(`[ATISU] page body snippet:`, bodySnip);
}

async function extractItems(page) {
  return page.evaluate(() => {
    const SEPS = ["→", "—", "–"];
    const results = [];

    // Try structured card selectors first
    const cardSelectors = [
      ".cargo-item", ".load-item", "[data-test='cargo-row']", "[data-test='load-row']",
      ".loads-list__item", "[class*='CargoItem']", "[class*='LoadItem']", "tr.result-row",
    ];
    let cards = [];
    for (const sel of cardSelectors) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }

    const parseCard = (text) => {
      const lines = text.split("\n").map(s => s.trim()).filter(Boolean);

      let from = "", to = "", distance = "";
      for (const sep of SEPS) {
        const routeLine = lines.find(l => l.includes(sep));
        if (!routeLine) continue;
        const idx = routeLine.indexOf(sep);
        from = routeLine.substring(0, idx).trim();
        const rest = routeLine.substring(idx + sep.length).trim();
        const dm = rest.match(/([\d\s]+\s*км)/i);
        distance = dm ? dm[1].trim() : "";
        to = rest.replace(/\s*[\d\s]+\s*км.*$/i, "").trim();
        break;
      }
      if (!from || !to || from.length > 70 || to.length > 70) return null;

      const weightM = text.match(/(\d[\d,. ]*)\s*т[^а-яёa-z]/i);
      const weight = weightM ? weightM[0].trim() : "";

      const priceM = text.match(/[\d\s.,]+\s*(руб|тнг|₽|тг)[.,\s]*(нал|карт|безнал)?/i);
      const price = priceM ? priceM[0].trim() : "";

      const truckKw = ["тент", "реф", "изот", "борт", "конт", "цист", "любая", "открыт", "термос"];
      const truck_type = lines.find(l => truckKw.some(t => l.toLowerCase().includes(t))) || "";

      const dateM = text.match(/\d{1,2}[./]\d{1,2}([./]\d{2,4})?/);
      const time = dateM ? dateM[0] : "";

      const cargo = lines.find(l =>
        l !== truck_type && l.length < 50 && !/^\d/.test(l) &&
        !/(руб|тнг|км|нал|карт)/i.test(l) &&
        !l.includes(from) && !l.includes(to)
      ) || "";

      return { from, to, distance, cargo, weight, truck_type, price, time };
    };

    if (cards.length > 0) {
      for (const card of cards) {
        const parsed = parseCard(card.innerText || "");
        if (parsed) results.push(parsed);
      }
    } else {
      // Fallback: find elements containing route separators
      const els = Array.from(document.querySelectorAll("a, td, div, span")).filter(el => {
        const t = el.textContent || "";
        return SEPS.some(s => t.includes(s)) && t.length < 120 && t.length > 5;
      });
      for (const el of els) {
        let container = el;
        for (let i = 0; i < 5; i++) {
          if (!container.parentElement) break;
          const txt = container.parentElement.innerText || "";
          if (txt.length > 30 && txt.length < 600) container = container.parentElement;
          else break;
        }
        const parsed = parseCard(container.innerText || "");
        if (parsed && parsed.from && parsed.to) results.push(parsed);
      }
    }

    // Deduplicate
    const seen = new Set();
    return results.filter(it => {
      const k = `${it.from}|${it.to}|${it.time}|${it.truck_type}`.toLowerCase().replace(/\s/g, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}
