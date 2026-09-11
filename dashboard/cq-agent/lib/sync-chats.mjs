import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, tradeCreds } from "./settings.mjs";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const CACHE_PATH = join(DATA_DIR, "client-chats-cache.json");
const DIGEST_PATH = join(DATA_DIR, "client-chats-digest.json");
const PAGE = 200;
const DIGEST_PER_CHAT = 40;

function enc(s) {
  return encodeURIComponent(s).replace(/%20/g, " ");
}

function odataDateTime(v) {
  const s = String(v || "").trim().replace(/Z$/i, "");
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : "2000-01-01T00:00:00";
}

function emptyCache() {
  return { updatedAt: null, chats: {}, contacts: {} };
}

export function readCache() {
  if (!existsSync(CACHE_PATH)) return emptyCache();
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    return {
      updatedAt: raw.updatedAt || null,
      chats: raw.chats && typeof raw.chats === "object" ? raw.chats : {},
      contacts: raw.contacts && typeof raw.contacts === "object" ? raw.contacts : {},
    };
  } catch {
    return emptyCache();
  }
}

function writeCache(cache) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

async function odataGet(path, creds) {
  const url = path.startsWith("http") ? path : new URL(path, creds.base).toString();
  const res = await fetch(url, {
    headers: { Authorization: creds.authHeader, Accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${url.slice(0, 160)} ${text.slice(0, 220).replace(/\s+/g, " ")}`);
  }
  return JSON.parse(text);
}

async function pageAll(creds, entity, filter, select, orderby) {
  const rows = [];
  let skip = 0;
  for (;;) {
    let path = `${entity}?%24format=json&%24top=${PAGE}&%24skip=${skip}`;
    if (filter) path += `&%24filter=${enc(filter)}`;
    if (select) path += `&%24select=${select}`;
    if (orderby) path += `&%24orderby=${orderby}`;
    const data = await odataGet(path, creds);
    const chunk = data.value || [];
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
    skip += PAGE;
  }
  return rows;
}

function writeDigest(cache) {
  const chats = Object.values(cache.chats).map((c) => {
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    const tail = msgs.slice(-DIGEST_PER_CHAT);
    return {
      ref: c.ref,
      code: c.code,
      name: c.name,
      client: c.client,
      clientKey: c.clientKey,
      managerKey: c.managerKey,
      messenger: c.messenger,
      created: c.created,
      lastMessageAt: c.lastMessageAt,
      messageCount: msgs.length,
      recent: tail.map((m) => ({
        at: m.at,
        text: m.text,
        contact: m.contactName || m.contact,
        contactCode: m.contactCode || "",
      })),
    };
  });
  const digest = {
    updatedAt: cache.updatedAt,
    chatCount: chats.length,
    messageCount: chats.reduce((s, c) => s + c.messageCount, 0),
    chats: chats.sort((a, b) => String(b.lastMessageAt || "").localeCompare(String(a.lastMessageAt || ""))),
  };
  writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2), "utf8");
  return digest;
}

export async function syncClientChats(settings) {
  const creds = tradeCreds(settings);
  const cache = readCache();

  const chatRows = await pageAll(
    creds,
    "Catalog_Чаты",
    `Клиент_Key ne guid'${EMPTY}' and DeletionMark eq false`,
    "Ref_Key,Code,Description,Клиент_Key,Менеджер_Key,Owner_Key,ДатаСоздания"
  );

  const clientIds = [...new Set(chatRows.map((c) => c.Клиент_Key).filter((id) => id && id !== EMPTY))];
  const clients = new Map();
  for (let i = 0; i < clientIds.length; i += 20) {
    const chunk = clientIds.slice(i, i + 20);
    const filter = chunk.map((id) => `Ref_Key eq guid'${id}'`).join(" or ");
    const data = await odataGet(
      `Catalog_Контрагенты?%24format=json&%24filter=${enc(filter)}&%24select=Ref_Key,Description`,
      creds
    );
    for (const r of data.value || []) clients.set(r.Ref_Key, r.Description);
  }

  const messengers = new Map();
  const messData = await odataGet(
    "Catalog_Мессенджеры?%24format=json&%24top=20&%24select=Ref_Key,Description",
    creds
  );
  for (const r of messData.value || []) messengers.set(r.Ref_Key, r.Description);

  const keep = new Set(chatRows.map((c) => c.Ref_Key));
  for (const id of Object.keys(cache.chats)) {
    if (!keep.has(id)) delete cache.chats[id];
  }

  let newMessages = 0;
  const contactNeed = new Set();

  for (const row of chatRows) {
    const prev = cache.chats[row.Ref_Key] || {
      ref: row.Ref_Key,
      messages: [],
    };
    const lastAt = odataDateTime(prev.lastMessageAt);
    let filter = `Owner_Key eq guid'${row.Ref_Key}' and DeletionMark eq false`;
    if (prev.lastMessageAt) {
      filter += ` and ДатаСоздания gt datetime'${lastAt}'`;
    }
    const msgs = await pageAll(
      creds,
      "Catalog_СообщенияЧатов",
      filter,
      "Ref_Key,Owner_Key,ДатаСоздания,ПредставлениеДанных,Контакт,Исходящее",
      "ДатаСоздания asc"
    );
    const mapped = msgs.map((m) => ({
      ref: m.Ref_Key,
      at: m.ДатаСоздания,
      text: String(m.ПредставлениеДанных || "").replace(/\s+/g, " ").trim().slice(0, 800),
      contact: m.Контакт || "",
      outgoing: Boolean(m.Исходящее),
    }));
    const seen = new Set((prev.messages || []).map((m) => m.ref));
    const added = mapped.filter((m) => m.ref && !seen.has(m.ref));
    newMessages += added.length;
    const messages = [...(prev.messages || []), ...added];
    const lastMsg = messages.length ? messages[messages.length - 1] : null;
    cache.chats[row.Ref_Key] = {
      ref: row.Ref_Key,
      code: row.Code,
      name: row.Description,
      clientKey: row.Клиент_Key,
      client: clients.get(row.Клиент_Key) || prev.client || row.Description,
      managerKey: row.Менеджер_Key,
      messenger: messengers.get(row.Owner_Key) || prev.messenger || "",
      created: row.ДатаСоздания,
      lastMessageAt: lastMsg?.at || prev.lastMessageAt || null,
      messages,
    };
    for (const m of added) {
      if (m.contact && m.contact !== EMPTY) contactNeed.add(m.contact);
    }
  }

  const missing = [...contactNeed].filter((id) => !cache.contacts[id]);
  for (let i = 0; i < missing.length; i += 15) {
    const chunk = missing.slice(i, i + 15);
    const filter = chunk.map((id) => `Ref_Key eq guid'${id}'`).join(" or ");
    const data = await odataGet(
      `Catalog_КонтактыМессенджеров?%24format=json&%24filter=${enc(filter)}&%24select=Ref_Key,Code,Description`,
      creds
    );
    for (const r of data.value || []) {
      cache.contacts[r.Ref_Key] = { name: String(r.Description || "").trim(), code: String(r.Code || "") };
    }
  }

  for (const chat of Object.values(cache.chats)) {
    for (const m of chat.messages || []) {
      const c = cache.contacts[m.contact];
      if (c) {
        m.contactName = c.name;
        m.contactCode = c.code;
      }
    }
  }

  cache.updatedAt = new Date().toISOString();
  writeCache(cache);
  const digest = writeDigest(cache);
  return {
    chats: digest.chatCount,
    messages: digest.messageCount,
    newMessages,
    digestPath: DIGEST_PATH,
    cachePath: CACHE_PATH,
  };
}

export { CACHE_PATH, DIGEST_PATH };
