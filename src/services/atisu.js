import { rand } from "../utils/timing.js";
import { launchChromiumForScrape } from "../utils/playwrightLaunch.js";
import { existsSync } from "fs";

const LOGIN_URL   = "https://id.ati.su";
const SEARCH_URL  = "https://loads.ati.su/";
const SESSION_PATH = "/tmp/atisu_session.json";

function firstCity(val) {
  if (!val) return null;
  return val.split(",")[0].trim();
}

const ATI_COUNTRY = {
  RUS: "Россия", KAZ: "Казахстан", BLR: "Беларусь", UKR: "Украина",
  UZB: "Узбекистан", KGZ: "Кыргызстан", TJK: "Таджикистан",
  ARM: "Армения", AZE: "Азербайджан", GEO: "Грузия", MDA: "Молдова",
};

const ATI_CAR_TYPE = {
  "1":"тент","2":"реф","4":"изотерм","8":"борт","16":"фург",
  "32":"цистерна","64":"любой","128":"контейнер","256":"термос","512":"самосвал",
};

const ATI_MONTHS = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : `${d.getDate()} ${ATI_MONTHS[d.getMonth()]}`;
}

function atiCity(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  return obj.location?.city
    || obj.cityName || obj.fullName
    || obj.city?.name || obj.city?.fullName
    || obj.geo?.city?.name || obj.geo?.cityName
    || obj.place?.cityName || obj.place?.name
    || obj.address?.city || obj.name || "";
}

function parseApiItem(it) {
  const loadingCity   = atiCity(it.loading);
  const unloadingCity = atiCity(it.unloading);

  const routeParts  = (it.route?.country || "").split("-");
  const fromCountry = ATI_COUNTRY[routeParts[0]] || "";
  const toCountry   = ATI_COUNTRY[routeParts[routeParts.length - 1]] || "";

  const from = loadingCity
    ? (fromCountry ? `${loadingCity}, ${fromCountry}` : loadingCity)
    : fromCountry;
  const to = unloadingCity
    ? (toCountry ? `${unloadingCity}, ${toCountry}` : unloadingCity)
    : toCountry;

  if (!from && !to) return null;

  const loadObj = it.load || {};
  const cargo   = it.loading?.loadingCargos?.[0]?.name || loadObj.cargoType || loadObj.name || "";

  const wt  = loadObj.weight > 0 ? loadObj.weight : null;
  const vol = loadObj.volume > 0 ? loadObj.volume : null;
  const weight = wt && vol ? `${wt}т / ${vol}м³` : wt ? `${wt}т` : vol ? `${vol}м³` : "";

  const truck_type = Array.isArray(it.truck?.carTypes)
    ? it.truck.carTypes.map(t => ATI_CAR_TYPE[String(t)] || t).filter(Boolean).join(", ")
    : (it.truck?.carTypeName || "");

  const rateObj = it.rate || {};
  let price = "";
  if (it.isHidden) {
    price = "скрыто (лицензия)";
  } else if (rateObj.sum > 0) {
    const cur = rateObj.currency || "₽";
    price = `${rateObj.sum.toLocaleString("ru-RU")} ${cur}`;
    if (rateObj.rateUnitType === 1) price += "/т";
    else if (rateObj.rateUnitType === 2) price += "/км";
  } else if (rateObj.negotiation || rateObj.rateType === 1) {
    price = "запрос ставки";
  } else if (rateObj.rateType === 2) {
    price = "скрыто";
  }

  const distance = it.route?.distance ? `${it.route.distance} км` : "";

  const d1 = fmtDate(it.loading?.firstDate);
  const d2 = fmtDate(it.loading?.lastDate);
  const time = d1 && d2 && d1 !== d2 ? `готов ${d1}-${d2}` : d1 ? `готов ${d1}` : "";

  return {
    from: String(from), to: String(to),
    cargo: String(cargo), weight: String(weight),
    price: String(price), truck_type: String(truck_type),
    distance: String(distance), time: String(time),
    source: "atisu",
  };
}

export async function scrapeAtisu(filters, sharedBrowser = null) {
  const ownsBrowser = !sharedBrowser;
  const browser = sharedBrowser || (await launchChromiumForScrape());

  try {
    const contextOpts = {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ru-RU",
      viewport: { width: 1280, height: 900 },
    };
    if (existsSync(SESSION_PATH)) {
      contextOpts.storageState = SESSION_PATH;
      console.log("[ATISU] loading saved session from", SESSION_PATH);
    }

    const context = await browser.newContext(contextOpts);
    // Block images/fonts/media — saves ~40-60% RAM per page load; not needed for scraping.
    // page.route for /loads/search takes priority and is unaffected by this context route.
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });
    const page    = await context.newPage();

    // Use page.route() to intercept loads/search — no async race condition
    // route.fetch() preserves browser cookies (auth session)
    let capturedLoads = null;
    await page.route(/\/loads\/search(\?|$)/, async (route) => {
      try {
        const resp = await route.fetch();
        const json = await resp.json().catch(() => null);
        if (json?.loads) {
          capturedLoads = json;
          console.log(`[ATISU] intercepted loads/search: totalItems=${json.totalItems}, loads=${json.loads.length}`);
        }
        await route.fulfill({ response: resp });
      } catch (e) {
        console.log(`[ATISU] route handler error: ${e.message}`);
        await route.continue();
      }
    });

    // Navigate to search — may trigger initial loads/search automatically
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await rand(1000, 1500);

    // Check if redirected to login or login link visible
    const onLoginPage = page.url().includes("id.ati.su");
    const hasLoginLink = !onLoginPage && !!(await page.$("a[href*='id.ati.su']"));

    if ((onLoginPage || hasLoginLink) && process.env.ATISU_LOGIN && process.env.ATISU_PASSWORD) {
      console.log("[ATISU] not authenticated — logging in...");
      if (!onLoginPage) await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await doLogin(page);
      try {
        await context.storageState({ path: SESSION_PATH });
        console.log("[ATISU] session saved to", SESSION_PATH);
      } catch (e) {
        console.log("[ATISU] session save failed:", e.message);
      }
      await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await rand(1000, 1500);
    }

    // Wait for initial page load + its auto-search to complete
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await rand(500, 800);

    const hasFilters = !!(filters.from || filters.to);
    if (hasFilters) {
      // Reset so we capture only the filtered response
      capturedLoads = null;
      await fillSearchForm(page, filters);
    }

    if (capturedLoads?.loads?.length > 0) {
      const items = capturedLoads.loads.map(parseApiItem).filter(Boolean);
      console.log(`[ATISU] extracted ${items.length} items (${capturedLoads.loads.length} raw)`);
      items.slice(0, 3).forEach((it, i) =>
        console.log(`[ATISU] [${i}] ${it.from} → ${it.to} | ${it.cargo} | ${it.weight} | ${it.truck_type} | ${it.price}`)
      );
      return items;
    }

    console.log("[ATISU] no API response captured, falling back to DOM...");
    return await extractItemsDom(page);

  } finally {
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}

async function doLogin(page) {
  const login    = process.env.ATISU_LOGIN;
  const password = process.env.ATISU_PASSWORD;

  console.log("[ATISU] starting login...");
  if (!page.url().includes("id.ati.su")) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  await rand(1500, 2000);

  const loginSel = [
    "input[name='login']", "input[name='email']", "input[type='email']",
    "input[placeholder*='Email']", "input[placeholder*='email']",
    "input[placeholder*='Телефон']", "input[placeholder*='логин']",
  ].join(", ");

  await page.waitForSelector(loginSel, { timeout: 15000, state: "visible" });
  await page.fill(loginSel, login);
  console.log("[ATISU] filled login field");
  await rand(400, 700);

  const passSel = "input[type='password']";
  const passVisible = await page.$(passSel).then(el => el?.isVisible().catch(() => false)).catch(() => false);

  if (!passVisible) {
    // Two-step: email first, then password appears on next screen
    console.log("[ATISU] two-step: submitting email first...");
    await submitForm(page);
    await page.waitForSelector(passSel, { timeout: 15000, state: "visible" }).catch(() => {});
  }

  const passEl = await page.$(passSel);
  if (passEl && await passEl.isVisible().catch(() => false)) {
    await page.fill(passSel, password);
    console.log("[ATISU] filled password field");
    await rand(400, 700);
  } else {
    console.log("[ATISU] WARNING: password field not found/visible");
  }

  // Click submit and wait for redirect away from id.ati.su
  await Promise.all([
    page.waitForURL(url => !url.includes("id.ati.su"), { timeout: 30000 }).catch(() => {}),
    submitForm(page),
  ]);

  const afterUrl = page.url();
  console.log(`[ATISU] login done, URL: ${afterUrl}`);
  if (afterUrl.includes("id.ati.su")) {
    console.log("[ATISU] WARNING: still on id.ati.su — login may have failed");
  }
}

async function submitForm(page) {
  const candidates = [
    "button:has-text('Войти')",
    "button:has-text('Продолжить')",
    "button:has-text('Далее')",
    "button:has-text('Вход')",
    "button:has-text('Sign in')",
    "button:has-text('Log in')",
    "button[type='submit']",
    "input[type='submit']",
    "form button",
  ];
  for (const sel of candidates) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        const txt = (await btn.textContent().catch(() => "")).trim();
        console.log(`[ATISU] submit: clicking "${txt || sel}"`);
        await btn.click();
        return;
      }
    } catch {}
  }
  console.log("[ATISU] submit: no button found, pressing Enter");
  await page.keyboard.press("Enter");
}

// ATI.SU only supports city-level search — skip pure country names
const COUNTRY_NAMES = new Set(Object.values({ RUS:"Россия",KAZ:"Казахстан",BLR:"Беларусь",UKR:"Украина",UZB:"Узбекистан",KGZ:"Кыргызстан",TJK:"Таджикистан",ARM:"Армения",AZE:"Азербайджан",GEO:"Грузия",MDA:"Молдова" }));

async function fillSearchForm(page, filters) {
  const fromRaw = firstCity(filters.from);
  const toRaw   = firstCity(filters.to);
  // ATI.SU city fields don't accept pure country names.
  const fromVal = fromRaw && !COUNTRY_NAMES.has(fromRaw) ? fromRaw : null;
  const toVal   = toRaw && !COUNTRY_NAMES.has(toRaw) ? toRaw : null;
  if (!fromVal && !toVal) return;

  console.log(
    `[ATISU] fillSearchForm: from="${fromVal || "(страна — пропуск)"}" to="${toVal || "(страна — пропуск)"}"`
  );

  const fillCity = async (label, selectors, value) => {
    if (!value) return;

    let handle = null;
    for (const sel of selectors) {
      try {
        handle = await page.waitForSelector(sel, { timeout: 4000, state: "visible" });
        if (handle) { console.log(`[ATISU] ${label}: matched "${sel}"`); break; }
      } catch {}
    }
    if (!handle) { console.log(`[ATISU] ${label}: input not found`); return; }

    // Clear via React's native value setter, then type
    await page.evaluate((el) => {
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, handle);
    await rand(150, 250);
    await handle.focus();
    await page.keyboard.type(value, { delay: 80 });
    await rand(1200, 1800);

    // Wait for dropdown options
    const optSel = "[role='option'], [class*='option']:not([class*='optionList']), li[data-value]";
    try {
      await page.waitForSelector(optSel, { timeout: 5000 });
    } catch {
      console.log(`[ATISU] ${label}: no dropdown appeared`);
      return;
    }

    const options = await page.$$eval(optSel, (els) =>
      els.filter(el => el.offsetParent !== null).map(el => el.textContent?.trim()).filter(Boolean)
    );
    console.log(`[ATISU] ${label}: options=${JSON.stringify(options.slice(0, 5))}`);

    const vl = value.toLowerCase();
    const best = options.find(t => t.toLowerCase() === vl)
      || options.find(t => t.toLowerCase().startsWith(vl + ","))
      || options.find(t => t.toLowerCase().startsWith(vl + " "))
      || options.find(t => t.toLowerCase().includes(vl))
      || options[0];

    if (!best) { console.log(`[ATISU] ${label}: no matching option`); return; }

    const clicked = await page.evaluate(({ txt, sel }) => {
      const items = Array.from(document.querySelectorAll(sel));
      const el = items.find(e => e.offsetParent !== null && e.textContent?.trim() === txt);
      if (el) { el.click(); return true; }
      return false;
    }, { txt: best, sel: optSel });

    console.log(`[ATISU] ${label}: ${clicked ? `selected "${best}"` : "click failed"}`);
    await rand(500, 800);
  };

  const fromSels = [
    "input[placeholder*='Например, Москва']",
    "input[placeholder*='Откуда']", "input[placeholder*='откуда']",
    "[class*='From'] input", "[class*='from'] input",
    "[class*='origin'] input", "[class*='Origin'] input",
  ];
  const toSels = [
    "input[placeholder*='Например, Санкт-Петербург']",
    "input[placeholder*='Куда']", "input[placeholder*='куда']",
    "[class*='To'] input",
    "[class*='destination'] input", "[class*='Destination'] input",
  ];

  if (fromVal) await fillCity("from", fromSels, fromVal);
  if (toVal)   await fillCity("to",   toSels,   toVal);
  await rand(1500, 2000);

  // Find and click search button
  const searchClicked = await page.evaluate(() => {
    const allBtns = Array.from(document.querySelectorAll("button"));
    const btn = allBtns.find(b => {
      const t = (b.innerText || "").trim();
      return /^найти\s*(груз)?$/i.test(t) || /^обновить$/i.test(t);
    });
    if (btn) { btn.click(); return `"${(btn.innerText || "").trim()}"`; }
    return null;
  });

  if (searchClicked) {
    console.log(`[ATISU] search clicked: ${searchClicked}`);
  } else {
    await page.keyboard.press("Enter");
    console.log("[ATISU] search submitted via Enter");
  }

  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await rand(2000, 3000);
  console.log(`[ATISU] search done, URL: ${page.url()}`);
}

async function extractItemsDom(page) {
  try {
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

    const foundEl = all.find(el =>
      el.children.length === 0 && /найдено\s+\d/i.test((el.textContent || "").trim())
    );
    if (!foundEl) return { items: [], debug: "no Найдено element" };

    const allLeafs = all.filter(el =>
      el.children.length === 0 && (el.innerText || "").trim()
    );
    const foundIdx = allLeafs.indexOf(foundEl);
    if (foundIdx < 0) return { items: [], debug: "Найдено not in leaf list" };

    const afterLeafs = allLeafs.slice(foundIdx + 1)
      .map(el => (el.innerText || "").trim())
      .filter(t => t && !NAV_SKIP.test(t));

    const beforeLeafs = allLeafs.slice(0, foundIdx)
      .map(el => (el.innerText || "").trim())
      .filter(Boolean);
    const preWeights = beforeLeafs.filter(t => WEIGHT_RE.test(t));

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
          const before = card.slice(0, dateIdx).filter(l => CITY_RE.test(l) && !TRUCK_KW.test(l));
          from = before[before.length - 1] || "";
          time = dateLine;
        }
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

    console.log(`[ATISU] DOM fallback: ${result.items?.length} items, cards=${result.debug?.cards}`);
    if (result.debug?.afterSample?.length) {
      console.log(`[ATISU] afterLeafs sample:`, JSON.stringify(result.debug.afterSample));
    }
    return result.items || [];
  } catch (e) {
    console.log(`[ATISU] extractItemsDom error (page may be closed): ${e.message}`);
    return [];
  }
}
