import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const USERS_FILE = join(root, "users.json");
const COOKIE = "dash_session";
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const TABS = ["hours", "activity", "pnl", "pnlecotidy", "units", "plan", "budget", "bitrix", "bitrixfreq", "ozon", "ozondrr", "ozonfbs", "ozonfbo", "ozonfbofilters", "wb", "debtors", "mbalance", "clientpay", "seo", "seoqueries", "seoproducts", "seopositions"];

const TAB_LABELS = {
  hours: "Часы",
  activity: "Активность",
  pnl: "Доходы и расходы",
  pnlecotidy: "ДИР Первый интегратор",
  units: "Сводка юнитов",
  plan: "Исполнение плана",
  budget: "Бюджет план-факт",
  bitrix: "Bitrix",
  bitrixfreq: "Чистота ведения Битрикс",
  ozon: "Озон себестоимость",
  ozondrr: "Озон ДРР",
  ozonfbs: "Отгрузки ФБС ozon",
  ozonfbo: "Отгрузки ФБО Озон",
  ozonfbofilters: "Поставки ФБО с фильтрами",
  wb: "WB рентабельность",
  debtors: "Задолженность клиентов",
  mbalance: "Управленческий баланс",
  clientpay: "Реестр оплат клиентов",
  seo: "Поиск SEO",
  seoqueries: "SEO запросы",
  seoproducts: "Все запросы по продуктам",
  seopositions: "Позиции в поисковиках",
};

function envValues() {
  const values = { ...process.env };
  for (const file of [join(root, ".env"), join(root, "odata.env")]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith("#")) continue;
      const eq = text.indexOf("=");
      if (eq < 1) continue;
      let val = text.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      const key = text.slice(0, eq).trim();
      if (values[key] == null || values[key] === "") values[key] = val;
    }
  }
  return values;
}

function loadStore() {
  if (!existsSync(USERS_FILE)) return { secret: "", users: [] };
  try {
    const raw = JSON.parse(readFileSync(USERS_FILE, "utf8"));
    return {
      secret: String(raw.secret || ""),
      users: Array.isArray(raw.users) ? raw.users : [],
    };
  } catch {
    return { secret: "", users: [] };
  }
}

function saveStore(store) {
  writeFileSync(USERS_FILE, JSON.stringify(store, null, 2), "utf8");
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 32).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const next = scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

function tabOn(tabs, key) {
  return !!(tabs && tabs[key] === true);
}

function normalizeTabs(tabs) {
  const src = tabs && typeof tabs === "object" ? tabs : {};
  const out = {};
  for (const key of TABS) out[key] = tabOn(src, key);
  return out;
}

/** Порядок вкладок: известные id без дублей, недостающие — в конец по умолчанию. */
function normalizeTabOrder(order) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(order) ? order : []) {
    const name = String(raw || "").trim();
    if (!TABS.includes(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  for (const name of TABS) {
    if (!seen.has(name)) out.push(name);
  }
  return out;
}

function publicUser(user) {
  return {
    id: user.id,
    login: user.login,
    admin: !!user.admin,
    tabs: normalizeTabs(user.tabs),
    tabOrder: normalizeTabOrder(user.tabOrder),
  };
}

export function cookieName() {
  return COOKIE;
}

export function ensureAuthReady() {
  const store = loadStore();
  let changed = false;
  if (!store.secret) {
    store.secret = envValues().DASHBOARD_SESSION_SECRET || randomBytes(32).toString("hex");
    changed = true;
  }
  if (!store.users.length) {
    const env = envValues();
    const login = String(env.DASHBOARD_ADMIN_LOGIN || "admin").trim() || "admin";
    let password = String(env.DASHBOARD_ADMIN_PASSWORD || "").trim();
    let generated = false;
    if (!password) {
      password = randomBytes(6).toString("base64url");
      generated = true;
    }
    const { salt, hash } = hashPassword(password);
    store.users.push({
      id: randomBytes(8).toString("hex"),
      login,
      salt,
      hash,
      admin: true,
      tabs: { hours: true, activity: true, pnl: true, pnlecotidy: true, units: true, plan: true, budget: true, bitrix: true, bitrixfreq: true, ozon: true, ozondrr: true, ozonfbs: true, ozonfbo: true, ozonfbofilters: true, wb: true, debtors: true, mbalance: true, clientpay: true },
      tabOrder: [...TABS],
    });
    changed = true;
    console.log(`First admin login: ${login}`);
    if (generated) console.log(`First admin password: ${password}`);
    else console.log("First admin password taken from DASHBOARD_ADMIN_PASSWORD");
  }
  for (const user of store.users) {
    if (!user.tabs || typeof user.tabs !== "object") {
      // Старые учётки без tabs — сохраняем прежний полный доступ один раз.
      user.tabs = Object.fromEntries(TABS.map((key) => [key, true]));
      changed = true;
    }
    if (user.tabs.ozonfbs == null) {
      user.tabs.ozonfbs = !!user.tabs.ozon;
      changed = true;
    }
    if (user.tabs.ozonfbo == null) {
      user.tabs.ozonfbo = !!(user.tabs.ozonfbs || user.tabs.ozon);
      changed = true;
    }
    if (user.tabs.ozonfbofilters == null) {
      user.tabs.ozonfbofilters = !!(user.tabs.ozonfbo || user.tabs.ozonfbs || user.tabs.ozon);
      changed = true;
    }
    // Новые доски (ключ отсутствует) — выключены, включает только администратор.
    for (const key of TABS) {
      if (user.tabs[key] == null) {
        user.tabs[key] = false;
        changed = true;
      }
    }
    const nextOrder = normalizeTabOrder(user.tabOrder);
    if (!Array.isArray(user.tabOrder) || JSON.stringify(user.tabOrder) !== JSON.stringify(nextOrder)) {
      user.tabOrder = nextOrder;
      changed = true;
    }
  }
  if (changed) saveStore(store);
  return store;
}

export function listPublicUsers() {
  return ensureAuthReady().users.map(publicUser);
}

export function findUserByLogin(login) {
  const name = String(login || "").trim().toLowerCase();
  return ensureAuthReady().users.find((u) => u.login.toLowerCase() === name) || null;
}

export function findUserById(id) {
  return ensureAuthReady().users.find((u) => u.id === id) || null;
}

export function checkLogin(login, password) {
  const user = findUserByLogin(login);
  if (!user || !password) return null;
  if (!verifyPassword(String(password), user.salt, user.hash)) return null;
  return user;
}

export function signSession(userId) {
  const store = ensureAuthReady();
  const exp = Date.now() + SESSION_MS;
  const payload = Buffer.from(JSON.stringify({ u: userId, e: exp })).toString("base64url");
  const sig = createHmac("sha256", store.secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function readSession(token) {
  if (!token || !token.includes(".")) return null;
  const store = ensureAuthReady();
  const [payload, sig] = token.split(".");
  const expect = createHmac("sha256", store.secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.u || Number(data.e) < Date.now()) return null;
    return findUserById(data.u) || null;
  } catch {
    return null;
  }
}

export function createUser({ login, password, admin, tabs, tabOrder }) {
  const store = ensureAuthReady();
  const name = String(login || "").trim();
  if (!name || name.length < 2) throw new Error("Логин слишком короткий");
  if (store.users.some((u) => u.login.toLowerCase() === name.toLowerCase())) {
    throw new Error("Такой логин уже есть");
  }
  if (!password || String(password).length < 4) throw new Error("Пароль слишком короткий");
  const isAdmin = !!admin;
  const { salt, hash } = hashPassword(String(password));
  const user = {
    id: randomBytes(8).toString("hex"),
    login: name,
    salt,
    hash,
    admin: isAdmin,
    tabs: normalizeTabs(tabs),
    tabOrder: normalizeTabOrder(tabOrder),
  };
  store.users.push(user);
  saveStore(store);
  return publicUser(user);
}

export function updateUser(id, patch) {
  const store = ensureAuthReady();
  const user = store.users.find((u) => u.id === id);
  if (!user) throw new Error("Пользователь не найден");
  if (patch.login != null) {
    const name = String(patch.login).trim();
    if (!name || name.length < 2) throw new Error("Логин слишком короткий");
    if (store.users.some((u) => u.id !== id && u.login.toLowerCase() === name.toLowerCase())) {
      throw new Error("Такой логин уже есть");
    }
    user.login = name;
  }
  if (patch.password) {
    if (String(patch.password).length < 4) throw new Error("Пароль слишком короткий");
    const next = hashPassword(String(patch.password));
    user.salt = next.salt;
    user.hash = next.hash;
  }
  if (patch.admin != null) {
    const nextAdmin = !!patch.admin;
    if (user.admin && !nextAdmin) {
      const admins = store.users.filter((u) => u.admin).length;
      if (admins <= 1) throw new Error("Нельзя снять права у последнего администратора");
    }
    user.admin = nextAdmin;
  }
  if (patch.tabs) user.tabs = normalizeTabs({ ...user.tabs, ...patch.tabs });
  if (patch.tabOrder) user.tabOrder = normalizeTabOrder(patch.tabOrder);
  saveStore(store);
  return publicUser(user);
}

/** Смена только своего порядка вкладок (без прав админа). */
export function updateOwnTabOrder(userId, tabOrder) {
  const store = ensureAuthReady();
  const user = store.users.find((u) => u.id === userId);
  if (!user) throw new Error("Пользователь не найден");
  user.tabOrder = normalizeTabOrder(tabOrder);
  saveStore(store);
  return publicUser(user);
}

export function removeUser(id, actorId) {
  const store = ensureAuthReady();
  const user = store.users.find((u) => u.id === id);
  if (!user) throw new Error("Пользователь не найден");
  if (user.id === actorId) throw new Error("Нельзя удалить свою учётку");
  if (user.admin && store.users.filter((u) => u.admin).length <= 1) {
    throw new Error("Нельзя удалить последнего администратора");
  }
  store.users = store.users.filter((u) => u.id !== id);
  saveStore(store);
}

export function userHasTab(user, tab) {
  return TABS.includes(tab) && publicUser(user).tabs[tab] === true;
}

export function filterDashboardData(data, user) {
  const tabs = publicUser(user).tabs;
  const out = { ...data };
  if (!tabs.hours) {
    out.charts = {};
    out.kpis = {};
    out.employees = [];
    out.statusTotals = {};
  }
  if (!tabs.activity) out.activity = [];
  if (!tabs.pnl) out.pnl = null;
  if (!tabs.pnlecotidy) out.pnlecotidy = null;
  if (!tabs.units) out.units = null;
  if (!tabs.plan) out.plan = null;
  if (!tabs.budget) out.budget = null;
  if (!tabs.bitrix) out.bitrix = null;
  if (!tabs.bitrixfreq) out.bitrixfreq = null;
  if (!tabs.ozon) out.ozon = null;
  if (!tabs.ozondrr) out.ozondrr = null;
  if (!tabs.wb) out.wb = null;
  if (!tabs.debtors) out.debtors = null;
  if (!tabs.mbalance) out.mbalance = null;
  if (!tabs.clientpay) out.clientpay = null;
  return out;
}

/** Защита входа от перебора: лимит по IP и по логину. */
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function attemptKey(kind, value) {
  return `${kind}:${String(value || "").trim().toLowerCase() || "-"}`;
}

function pruneAttempt(key, now = Date.now()) {
  const row = loginAttempts.get(key);
  if (!row) return null;
  if (row.lockedUntil && row.lockedUntil <= now) {
    loginAttempts.delete(key);
    return null;
  }
  if (!row.lockedUntil && now - row.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  return row;
}

function lockedRetrySec(row, now = Date.now()) {
  if (!row?.lockedUntil || row.lockedUntil <= now) return 0;
  return Math.max(1, Math.ceil((row.lockedUntil - now) / 1000));
}

export function clientIp(req) {
  const xf = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  if (xf) return xf;
  const real = String(req.headers?.["x-real-ip"] || "").trim();
  if (real) return real;
  return String(req.socket?.remoteAddress || "unknown");
}

/** @returns {{ ok: true } | { ok: false, retryAfterSec: number, error: string }} */
export function checkLoginThrottle(ip, login) {
  const now = Date.now();
  let worst = 0;
  for (const key of [attemptKey("ip", ip), attemptKey("login", login)]) {
    const row = pruneAttempt(key, now);
    const sec = lockedRetrySec(row, now);
    if (sec > worst) worst = sec;
  }
  if (worst > 0) {
    const mins = Math.ceil(worst / 60);
    return {
      ok: false,
      retryAfterSec: worst,
      error: `Слишком много неудачных попыток. Повторите через ${mins} мин.`,
    };
  }
  return { ok: true };
}

export function registerLoginFailure(ip, login) {
  const now = Date.now();
  for (const key of [attemptKey("ip", ip), attemptKey("login", login)]) {
    let row = pruneAttempt(key, now);
    if (!row) row = { count: 0, firstAt: now, lockedUntil: 0 };
    row.count += 1;
    if (row.count >= LOGIN_MAX_FAILS) {
      row.lockedUntil = now + LOGIN_LOCK_MS;
    }
    loginAttempts.set(key, row);
  }
  if (loginAttempts.size > 5000) {
    for (const key of [...loginAttempts.keys()]) pruneAttempt(key, now);
  }
}

export function clearLoginFailures(ip, login) {
  loginAttempts.delete(attemptKey("ip", ip));
  loginAttempts.delete(attemptKey("login", login));
}

export { publicUser, TABS, TAB_LABELS, normalizeTabOrder };
