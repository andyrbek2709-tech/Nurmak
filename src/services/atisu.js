import { chromium } from "playwright";
import { rand } from "../utils/timing.js";

const LOGIN_URL  = "https://id.ati.su";
const SEARCH_URL = "https://loads.ati.su/";

function firstCity(val) {
  if (!val) return null;
  return val.split(",")[0].trim();
}

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

    // Track all non-asset requests to discover ATI.SU API endpoints
    const requestUrls = [];
    page.on("request", (req) => {
      if (requestUrls.length >= 100) return;
      const url = req.url();
      if (url.includes("ati.su") && !/\.(js|css|png|jpg|ico|woff2?|svg|ttf|eot)(\?|$)/i.test(url)) {
        requestUrls.push(`${req.method()} ${url.substring(0, 150)}`);
      }
    });

    // Intercept ALL JSON responses from ati.su to find the cargo search API
    const apiResponses = [];
    page.on("response", async (response) => {
      try {
        const url = response.url();
        if (!url.includes("ati.su")) return;
        if (response.status() < 200 || response.status() >= 300) return;
        const ct = response.headers()["content-type"] || "";
        if (!ct.includes("json")) return;
        const json = await response.json().catch(() => null);
        if (!json) return;
        apiResponses.push({ url, json });
      } catch (_) {}
    });

    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await rand(1500, 2000);

    const needsLogin = await page.evaluate(() =>
      !!document.querySelector("a[href*='login'], a[href*='signin'], [data-test='login-btn']")
      || !document.cookie.includes("atiauth")
    );
    if (needsLogin) await doLogin(page);

    await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });
    await rand(1000, 1500);

    // Clear responses captured during page load — only want search results
    apiResponses.length = 0;

    await fillSearchForm(page, filters);
    await rand(1000, 1500);

    console.log(`[ATISU] scraping URL: ${page.url()}`);
    console.log(`[ATISU] API requests (last 20): ${requestUrls.slice(-20).join(" | ")}`);
    console.log(`[ATISU] API responses captured: ${apiResponses.length}`);

    // Log all captured API endpoints to discover cargo data source
    for (const r of apiResponses) {
      const keys = Object.keys(r.json || {}).slice(0, 8).join(",");
      const isArr = Array.isArray(r.json);
      const len = isArr ? r.json.length : (Array.isArray(r.json?.items) ? r.json.items.length : "");
      console.log(`[ATISU] api: ${r.url.replace("https://", "").substring(0, 90)} | ${isArr ? `array[${len}]` : `{${keys}}`}${len !== "" ? ` len=${len}` : ""}`);
    }

    // Try to extract from API first
    const fromApi = extractFromApiResponses(apiResponses);
    if (fromApi.length > 0) {
      console.log(`[ATISU] extracted ${fromApi.length} items from API`);
      fromApi.slice(0, 3).forEach((it, i) =>
        console.log(`[ATISU] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" price="${it.price}"`)
      );
      return fromApi;
    }

    // Fallback: DOM extraction
    console.log(`[ATISU] API extraction got 0, trying DOM...`);
    const items = await extractItemsDom(page);
    items.slice(0, 3).forEach((it, i) =>
      console.log(`[ATISU] item[${i}]: from="${it.from}" to="${it.to}" cargo="${it.cargo}" price="${it.price}"`)
    );
    return items;
  } finally {
    await browser.close();
  }
}

function extractFromApiResponses(apiResponses) {
  // ATI.SU cargo API returns objects with load details
  // Try several known patterns for the response shape
  for (const { url, json } of apiResponses) {
    // Pattern 1: { items: [...] } where items have cargo fields
    const candidates = Array.isArray(json) ? json
      : Array.isArray(json?.items) ? json.items
      : Array.isArray(json?.loads) ? json.loads
      : Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.result) ? json.result
      : null;

    if (!candidates || candidates.length === 0) continue;

    const first = candidates[0];
    if (!first || typeof first !== "object") continue;

    // Check if this looks like a cargo/load record
    const hasLoad = "from" in first || "to" in first || "weight" in first
      || "fromCity" in first || "toCity" in first || "cargo" in first
      || "origin" in first || "destination" in first
      || "departureCity" in first || "arrivalCity" in first
      || "loadingCity" in first || "unloadingCity" in first
      || "cityFrom" in first || "cityTo" in first
      || "route" in first || "distance" in first;

    if (!hasLoad) continue;

    console.log(`[ATISU] found cargo data at: ${url.substring(0, 80)}`);
    console.log(`[ATISU] record keys: ${Object.keys(first).join(",").substring(0, 120)}`);

    return candidates.map(it => parseApiItem(it)).filter(Boolean);
  }
  return [];
}

function parseApiItem(it) {
  // Try multiple known field name patterns from ATI.SU API
  const from = it.fromCity?.name || it.from?.city?.name || it.from?.name
    || it.origin?.city || it.loadingCity || it.cityFrom?.name || it.cityFrom
    || it.departureCity || "";
  const to = it.toCity?.name || it.to?.city?.name || it.to?.name
    || it.destination?.city || it.unloadingCity || it.cityTo?.name || it.cityTo
    || it.arrivalCity || "";
  const cargo = it.cargo?.name || it.cargo || it.cargoName || it.freightName || "";
  const weight = it.weight || it.tonnage || "";
  const price = it.price || it.rate || it.cost || "";
  const truck_type = it.truckType?.name || it.truckType || it.bodyType?.name || it.bodyType || "";
  const distance = it.distance || "";
  const time = it.loadingDate || it.departureDate || it.readyAt || "";

  if (!from && !to) return null;
  return { from: String(from), to: String(to), cargo: String(cargo), weight: String(weight), price: String(price), truck_type: String(truck_type), distance: String(distance), time: String(time), source: "atisu" };
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

  // Use only the first city for ATI.SU (no multi-city support)
  const fromVal = firstCity(filters.from);
  const toVal   = firstCity(filters.to);
  console.log(`[ATISU] fillSearchForm: from="${fromVal}" to="${toVal}" (raw: from="${filters.from}" to="${filters.to}")`);

  const fillReactInput = async (label, selectorList, value) => {
    if (!value) return;

    let handle = null;
    let matchedSel = null;
    for (const sel of selectorList) {
      try {
        handle = await page.waitForSelector(sel, { timeout: 3000, state: "visible" });
        matchedSel = sel;
        break;
      } catch (_) {}
    }
    if (!handle) { console.log(`[ATISU] ${label}: no input found`); return; }
    console.log(`[ATISU] ${label}: matched "${matchedSel}"`);

    await page.evaluate((el) => {
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeSetter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, handle);
    await rand(200, 300);
    await page.evaluate((el) => el.focus(), handle);
    await page.keyboard.type(value, { delay: 80 });
    await rand(1200, 1600);

    try {
      await page.waitForSelector("[role='option']", { timeout: 5000 });
    } catch (_) {
      console.log(`[ATISU] ${label}: no dropdown appeared`);
      return;
    }

    const options = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[role='option']"))
        .filter(el => el.offsetParent !== null)
        .map(el => el.textContent?.trim() || "")
        .filter(Boolean)
    );
    console.log(`[ATISU] ${label}: options:`, JSON.stringify(options));

    const vl = value.toLowerCase();
    const best = options.find(t => t.toLowerCase() === vl)
      || options.find(t => t.toLowerCase().startsWith(vl + ","))
      || options.find(t => t.toLowerCase().startsWith(vl + " "))
      || options[0];

    if (!best) { console.log(`[ATISU] ${label}: no option to click`); return; }

    const clicked = await page.evaluate((text) => {
      const items = Array.from(document.querySelectorAll("[role='option']"));
      const item = items.find(el => el.offsetParent !== null && el.textContent?.trim() === text);
      if (item) { item.click(); return true; }
      return false;
    }, best);
    console.log(`[ATISU] ${label}: ${clicked ? `clicked "${best}"` : "click failed"}`);
    await rand(600, 900);
  };

  const fromSelectors = [
    "input[placeholder*='Например, Москва']",
    "[class*='From'] input", "[class*='from'] input",
    "input[placeholder*='Откуда']", "input[placeholder*='откуда']",
  ];
  const toSelectors = [
    "input[placeholder*='Например, Санкт-Петербург']",
    "[class*='To'] input", "[class*='to'] input",
    "input[placeholder*='Куда']", "input[placeholder*='куда']",
  ];

  if (fromVal) await fillReactInput("from", fromSelectors, fromVal);
  if (toVal)   await fillReactInput("to",   toSelectors,   toVal);

  await rand(2000, 2500);

  const submitted = await page.evaluate(() => {
    const SKIP = /выбрать\s*список|очистить|добавить|войти|регистр|фильтр/i;
    const allBtns = Array.from(document.querySelectorAll("button"));
    const byText = allBtns.find(b => {
      const t = (b.innerText || "").trim();
      return /^найти\s*груз/i.test(t) || /^обновить/i.test(t) || /^найти$/i.test(t);
    });
    if (byText) { byText.click(); return `text: "${(byText.innerText || "").trim()}"`; }

    const fromInput = document.querySelector("input[placeholder*='Например, Москва']");
    if (fromInput) {
      let el = fromInput.parentElement;
      for (let depth = 0; depth < 10; depth++) {
        if (!el) break;
        const btns = Array.from(el.querySelectorAll("button")).filter(b => {
          const t = (b.innerText || "").trim();
          return t.length > 0 && t.length < 40 && !SKIP.test(t);
        });
        if (btns.length > 0) {
          const btn = btns[btns.length - 1];
          btn.click();
          return `form-container: "${(btn.innerText || "").trim()}"`;
        }
        el = el.parentElement;
      }
    }
    return null;
  });

  if (submitted) {
    console.log(`[ATISU] search submitted via ${submitted}`);
  } else {
    await page.evaluate(() => {
      const toInput = document.querySelector("input[placeholder*='Например, Санкт-Петербург']");
      if (toInput) {
        toInput.focus();
        toInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        toInput.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      }
    });
    console.log(`[ATISU] search submitted via keyboard Enter`);
  }

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await rand(3000, 4000);
  console.log(`[ATISU] search done, URL: ${page.url()}`);

  const bodySnip = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log(`[ATISU] body snippet:`, bodySnip);
}

async function extractItemsDom(page) {
  await page.waitForFunction(
    () => document.body.innerText.includes("Найдено"),
    { timeout: 5000 }
  ).catch(() => {});

  const result = await page.evaluate(() => {
    const DATE_KW    = /готов|погрузка|апр|мар|фев|янв|май|июн|июл|авг|сен|окт|ноя|дек/i;
    const CARD_START = /^(изм|доб)\s+\d/i;
    const CITY_RE    = /^[А-ЯЁ][а-яё]/;
    const KM_RE      = /\d[\d\s]*\s*км/;
    const PRICE_KW   = /скрыто|запрос|руб|тнг|₽|нал|безнал/i;
    const TRUCK_KW   = /^(тент|реф|изот|борт|конт|цист|любая|открыт|термос)/i;
    const WEIGHT_RE  = /\d[\d,]*\s*\/\s*[\d\-]/;
    const NAV_SKIP   = /^(войти|зарегистрироваться|все сервисы|ваши|добавить|заказы|курьер|поиск грузов|тёмная тема|найти груз|фильтры|история поиска|по машинам|цепочки|отслеживаемые|ати|площадки|загр\/выгр|отд\.машина|обновить|показать контакты|доступно|популярные|инструкция|по поиску|расчет|защита|оплата|грузовладельцам|перевозчикам|выводить|упорядочить|времени|вид$|маршрут$|ставка$|транспорт$|направл\.$)/i;

    const all = Array.from(document.querySelectorAll("*"));

    // Find "Найдено N груза" leaf element
    const foundEl = all.find(el =>
      el.children.length === 0 && /найдено\s+\d/i.test((el.textContent || "").trim())
    );
    if (!foundEl) return { items: [], debug: "no Найдено element" };

    // Collect ALL leaf elements in DOM order, find position of foundEl
    const allLeafs = all.filter(el =>
      el.children.length === 0 && (el.innerText || "").trim()
    );
    const foundIdx = allLeafs.indexOf(foundEl);
    if (foundIdx < 0) return { items: [], debug: "Найдено not in leaf list" };

    // Get all leaf texts AFTER "Найдено" — these are the sequential result cards
    const afterLeafs = allLeafs.slice(foundIdx + 1)
      .map(el => (el.innerText || "").trim())
      .filter(t => t && !NAV_SKIP.test(t));

    // Also collect weight data from BEFORE "Найдено" (weight column renders early)
    const beforeLeafs = allLeafs.slice(0, foundIdx)
      .map(el => (el.innerText || "").trim())
      .filter(Boolean);
    const preWeights = beforeLeafs.filter(t => WEIGHT_RE.test(t));

    // Split afterLeafs into cards at each "изм/доб DATE" boundary
    const cards = [];
    let cur = [];
    for (const t of afterLeafs) {
      if (CARD_START.test(t) && cur.length > 0) {
        cards.push(cur);
        cur = [t];
      } else {
        cur.push(t);
      }
    }
    if (cur.length > 0) cards.push(cur);

    const items = [];
    for (const card of cards) {
      const truck_type = card.find(l => TRUCK_KW.test(l)) || "";
      const price      = card.find(l => PRICE_KW.test(l)) || "";
      const km         = (card.find(l => KM_RE.test(l)) || "").match(/(\d[\d\s]*\s*км)/)?.[1]?.trim() || "";

      const dateIdx = card.findIndex(l => DATE_KW.test(l) && !CARD_START.test(l));
      let from = "", time = "", to = "";

      if (dateIdx >= 0) {
        const dateLine = card[dateIdx];
        const merged = dateLine.match(/^([А-ЯЁ][а-яёА-ЯЁ\s\-]+?)(готов\b|погрузка\b|\d{1,2}[\s\-])/i);
        if (merged && merged[1].trim().length >= 2) {
          from = merged[1].trim();
          time = dateLine.substring(merged[1].length).trim();
        } else {
          // from city = last Cyrillic word before date
          const before = card.slice(0, dateIdx).filter(l => CITY_RE.test(l) && !TRUCK_KW.test(l));
          from = before[before.length - 1] || "";
          time = dateLine;
        }
        // to city = first Cyrillic word after date not equal to from
        for (let j = dateIdx + 1; j < card.length; j++) {
          const l = card[j];
          if (CITY_RE.test(l) && !PRICE_KW.test(l) && !TRUCK_KW.test(l) && l !== from) {
            to = l; break;
          }
        }
      }

      const idx = items.length;
      const wLeaf = preWeights[idx] || "";
      const weight = wLeaf.match(/^([\d,. /]+)/)?.[1]?.trim() || "";
      const cargo  = wLeaf.replace(/^[\d,. /\-\s]+/, "").trim();

      if (from && to && from !== to && CITY_RE.test(from)) {
        items.push({ from, to, distance: km, cargo, weight, truck_type, price, time, source: "atisu" });
      }
    }

    return {
      items,
      debug: {
        cards: cards.length,
        card0: cards[0]?.slice(0, 15),
        preWeights: preWeights.slice(0, 5),
        afterSample: afterLeafs.slice(0, 30),
        foundText: (foundEl?.textContent || "").trim().substring(0, 60),
      },
    };
  });

  console.log(`[ATISU] DOM card-parse: ${result.items?.length} items, cards=${result.debug?.cards}`);
  console.log(`[ATISU] foundEl: "${result.debug?.foundText}"`);
  console.log(`[ATISU] afterLeafs[0..30]:`, JSON.stringify(result.debug?.afterSample));
  if (result.debug?.cards > 0) {
    console.log(`[ATISU] card[0]:`, JSON.stringify(result.debug?.card0));
  }
  if (result.items?.length === 0) {
    console.log(`[ATISU] preWeights:`, JSON.stringify(result.debug?.preWeights));
  }
  return result.items || [];
}
