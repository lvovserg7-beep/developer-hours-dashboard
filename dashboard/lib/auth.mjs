import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const USERS_FILE = join(root, "users.json");
const COOKIE = "dash_session";
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const TABS = ["hours", "activity", "pnl"];

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

function publicUser(user) {
  return {
    id: user.id,
    login: user.login,
    admin: !!user.admin,
    tabs: {
      hours: user.tabs?.hours !== false,
      activity: user.tabs?.activity !== false,
      pnl: user.tabs?.pnl !== false,
    },
  };
}

function normalizeTabs(tabs, admin) {
  const src = tabs && typeof tabs === "object" ? tabs : {};
  const out = {
    hours: src.hours !== false,
    activity: src.activity !== false,
    pnl: src.pnl !== false,
  };
  if (admin) return out;
  return out;
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
      tabs: { hours: true, activity: true, pnl: true },
    });
    changed = true;
    console.log(`First admin login: ${login}`);
    if (generated) console.log(`First admin password: ${password}`);
    else console.log("First admin password taken from DASHBOARD_ADMIN_PASSWORD");
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

export function createUser({ login, password, admin, tabs }) {
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
    tabs: normalizeTabs(tabs, isAdmin),
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
  if (patch.tabs) user.tabs = normalizeTabs({ ...user.tabs, ...patch.tabs }, user.admin);
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
  return out;
}

export { publicUser, TABS };
