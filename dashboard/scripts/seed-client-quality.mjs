import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { odataAllPages, odataGet } from "../lib/odata.mjs";

const EMPTY = "00000000-0000-0000-0000-000000000000";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data");

function enc(s) {
  return encodeURIComponent(s);
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfWeek(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfWeek(d = new Date()) {
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 7);
  return e;
}

const NEGATIVE_RE =
  /не\s*работает|ужас|кошмар|безобрази|возмущ|жалоб|претензи|развод|кидаете|кидаеш|обман|вранье|враньё|хамств|наплева|долго\s*ждём|долго\s*ждем|когда\s*уже|достал|бесит|разочар|неудовлетвор|штраф|возврат\s*денег|верните\s*деньг|суд\s|адвокат|плохо\s*работа|уже\s*\d+\s*дн|ждём\s*ответ|ждем\s*ответ|нет\s*ответа/i;

const PROMISE_RE =
  /сделаем|подготовим|пришл[еюём]|отправ[люим]|созвоним|свяжемся|вернёмся|вернемся|посмотрим|проверим|завтра|сегодня|в\s*понедельник|во\s*вторник|в\s*среду|в\s*четверг|в\s*пятниц|на\s*этой\s*неделе|до\s*\d|к\s*\d{1,2}[\.\/]|обеща|договорились|сделаю|скину|дам\s*знать|напишу\s*как|как\s*будет\s*готово|опубликуем|выложим|внедрим/i;

const QUESTION_RE =
  /\?|как\s+|где\s+|когда\s+|сколько\s+|можно\s+ли|нужно\s+ли|что\s+делать|как\s+настроить|как\s+подключ|инструкц|не\s+понимаю|подскажите|возможно\s+ли/i;

const OUR_TEXT_RE =
  /опубликовали\s+новый\s+релиз|коллеги!|с\s+нашей\s+стороны|мы\s+сделали|передала?\s+в\s+разработ|поставил[аи]\s+в\s+спринт/i;

const SERVICE_CONTACT_RE = /Group\s*@|AnonymousBot|^бот$/i;

function normalizePerson(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/@[\w._-]+/g, " ")
    .replace(/[«»"""']/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-zа-яё0-9\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(name) {
  return normalizePerson(name)
    .split(" ")
    .filter((t) => t.length >= 3 && !/^(ooo|ооо|ип|the|and)$/i.test(t));
}

function buildStaffIndex(userNames, extraNames = []) {
  const entries = [];
  for (const raw of [...userNames, ...extraNames]) {
    const norm = normalizePerson(raw);
    if (!norm) continue;
    const toks = tokens(raw);
    if (!toks.length) continue;
    entries.push({ raw, norm, toks, first: toks[0], last: toks[toks.length - 1] });
  }
  return entries;
}

function matchStaff(contactName, staffIndex) {
  const norm = normalizePerson(contactName);
  if (!norm || SERVICE_CONTACT_RE.test(contactName)) return null;
  const cToks = tokens(contactName);
  if (!cToks.length) return null;

  for (const s of staffIndex) {
    if (norm === s.norm) return s.raw;
    // «Мария Сайганова» vs «Сайганова Мария …»
    if (cToks.length >= 2 && s.toks.length >= 2) {
      const overlap = cToks.filter((t) => s.toks.includes(t));
      if (overlap.length >= 2) return s.raw;
    }
    // «Кирилл @x» vs «Ральченко Кирилл Андреевич»
    if (cToks.length === 1 && s.toks.includes(cToks[0]) && s.toks.length >= 2) {
      // first name only — weak; accept if имя не слишком частое? keep for Кирилл among employees list only later
      if (cToks[0].length >= 5) return s.raw;
    }
  }
  return null;
}

function textOf(msg) {
  return String(msg.ПредставлениеДанных || "").replace(/\s+/g, " ").trim();
}

function contactKey(msg) {
  const c = msg.Контакт;
  if (!c) return "";
  if (typeof c === "string") return c;
  if (typeof c === "object" && c.Ref_Key) return c.Ref_Key;
  return String(c);
}

async function loadUsers() {
  const users = await odataAllPages(
    "Catalog_Пользователи?$select=Ref_Key,Description&$filter=DeletionMark eq false",
    { maxPages: 10, database: "trade" }
  );
  const map = new Map();
  for (const u of users) map.set(u.Ref_Key, u.Description || u.Ref_Key);
  return map;
}

async function loadClientsMap(keys) {
  const map = new Map();
  const uniq = [...new Set(keys.filter((k) => k && k !== EMPTY))];
  for (let i = 0; i < uniq.length; i += 20) {
    const chunk = uniq.slice(i, i + 20);
    const filter = chunk.map((k) => `Ref_Key eq guid'${k}'`).join(" or ");
    const rows = await odataAllPages(
      `Catalog_Контрагенты?$select=Ref_Key,Description&$filter=${enc(filter)}`,
      { maxPages: 5, database: "trade" }
    );
    for (const r of rows) map.set(r.Ref_Key, r.Description || r.Ref_Key);
  }
  return map;
}

async function resolveContacts(ids) {
  const map = new Map();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (const id of uniq) {
    try {
      const r = await odataGet(
        `Catalog_КонтактыМессенджеров(guid'${id}')?$select=Ref_Key,Description,Code`,
        "trade"
      );
      map.set(id, r.Description || "");
    } catch {
      map.set(id, "");
    }
  }
  return map;
}

function loadEmployeeNames() {
  try {
    const snap = JSON.parse(readFileSync(join(outDir, "snapshot.json"), "utf8"));
    return (snap.employees || [])
      .map((e) => e.name || e.employee || e.Description || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  console.log("Loading client chats...");
  const chats = await odataAllPages(
    `Catalog_Чаты?$select=Ref_Key,Description,Code,ДатаСоздания,Клиент_Key,Менеджер_Key,Owner_Key&$filter=${enc(
      `DeletionMark eq false and Клиент_Key ne guid'${EMPTY}'`
    )}&$orderby=ДатаСоздания desc&$top=300`,
    { maxPages: 8, database: "trade" }
  );
  console.log("chats", chats.length);

  const usersMap = await loadUsers();
  const staffIndex = buildStaffIndex([...usersMap.values()], loadEmployeeNames());
  console.log("users", usersMap.size, "staffIndex", staffIndex.length);

  const clientsMap = await loadClientsMap(chats.map((c) => c.Клиент_Key));
  console.log("clients", clientsMap.size);

  const since = new Date();
  since.setDate(since.getDate() - 60);
  const sinceIso = since.toISOString().slice(0, 19);

  const msgsByChat = new Map();
  const contactIds = new Set();
  let loaded = 0;
  const focus = chats.slice(0, 80);
  for (const chat of focus) {
    const path =
      `Catalog_СообщенияЧатов?$select=Ref_Key,ДатаСоздания,ПредставлениеДанных,Исходящее,Пользователь_Key,Контакт,Контакт_Type,Owner_Key` +
      `&$filter=${enc(`Owner_Key eq guid'${chat.Ref_Key}' and ДатаСоздания ge datetime'${sinceIso}'`)}` +
      `&$orderby=ДатаСоздания asc&$top=250`;
    try {
      const msgs = await odataAllPages(path, { maxPages: 3, database: "trade" });
      msgsByChat.set(chat.Ref_Key, msgs);
      for (const m of msgs) {
        const ck = contactKey(m);
        if (ck && ck !== EMPTY) contactIds.add(ck);
      }
      loaded += 1;
      if (loaded % 10 === 0) console.log("chats with msgs", loaded, "/", focus.length);
    } catch (e) {
      console.warn("msg load fail", chat.Description, e.message || e);
    }
  }

  console.log("resolving contacts", contactIds.size);
  const contactMap = await resolveContacts([...contactIds]);

  /** contactId -> staff name or null (unknown) / false (client-ish unknown we won't mark as ours) */
  const ourContact = new Map();
  for (const [id, name] of contactMap) {
    const staff = matchStaff(name, staffIndex);
    if (staff) ourContact.set(id, staff);
  }
  console.log("our contacts matched", ourContact.size, [...ourContact.entries()].slice(0, 8));

  function isOurSide(msg) {
    const userKey = String(msg.Пользователь_Key || "");
    if (userKey && userKey !== EMPTY) return { ours: true, who: usersMap.get(userKey) || "Сотрудник" };
    if (msg.Исходящее === true) return { ours: true, who: "Исходящее" };
    const ck = contactKey(msg);
    if (ck && ourContact.has(ck)) return { ours: true, who: ourContact.get(ck) };
    const t = textOf(msg);
    if (OUR_TEXT_RE.test(t)) return { ours: true, who: contactMap.get(ck) || "Команда" };
    return { ours: false, who: contactMap.get(ck) || "" };
  }

  const managerDeltas = new Map();
  const managerNameByKey = new Map();
  const openPromises = [];
  const negativity = [];
  const dueThisWeek = [];
  const ping = [];
  const faqMap = new Map();

  const weekStart = startOfWeek();
  const weekEnd = endOfWeek();
  const now = new Date();

  for (const chat of focus) {
    const msgs = msgsByChat.get(chat.Ref_Key) || [];
    if (!msgs.length) continue;
    const clientName = clientsMap.get(chat.Клиент_Key) || chat.Description || "Клиент";
    const managerKey = chat.Менеджер_Key && chat.Менеджер_Key !== EMPTY ? chat.Менеджер_Key : "";
    let managerName = managerKey ? usersMap.get(managerKey) || "Менеджер" : "";

    let waitingSince = null;
    let lastClientAt = null;
    let lastOurAt = null;
    let lastClientText = "";
    let lastOurWho = "";
    /** @type {null | {at:Date, excerpt:string, who:string}} */
    let lastPromise = null;

    for (const msg of msgs) {
      const t = textOf(msg);
      if (!t || t.length < 2) continue;
      const ck = contactKey(msg);
      const cname = contactMap.get(ck) || "";
      if (SERVICE_CONTACT_RE.test(cname)) continue;
      const at = parseDate(msg.ДатаСоздания);
      if (!at) continue;
      const side = isOurSide(msg);

      if (!side.ours) {
        if (waitingSince == null) waitingSince = at;
        lastClientAt = at;
        lastClientText = t;
        if (NEGATIVE_RE.test(t)) {
          negativity.push({
            id: `neg-${msg.Ref_Key}`,
            client: clientName,
            clientKey: chat.Клиент_Key,
            chat: chat.Description,
            chatKey: chat.Ref_Key,
            manager: managerName || "Не назначен",
            managerKey,
            at: at.toISOString(),
            excerpt: t.slice(0, 180),
            status: "open",
          });
        }
        if (QUESTION_RE.test(t) && t.length >= 16 && t.length <= 180 && !/^photos_file/i.test(t)) {
          const norm = t
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s?]/gu, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 90);
          if (!faqMap.has(norm)) faqMap.set(norm, { query: t.slice(0, 140), count: 0, clients: new Set() });
          const row = faqMap.get(norm);
          row.count += 1;
          row.clients.add(clientName);
        }
      } else {
        if (!managerName) {
          managerName = side.who || managerName;
        }
        if (waitingSince) {
          const deltaMin = (at - waitingSince) / 60000;
          if (deltaMin >= 0 && deltaMin < 7 * 24 * 60) {
            const mk = managerKey || side.who || "unknown";
            if (!managerDeltas.has(mk)) managerDeltas.set(mk, []);
            managerDeltas.get(mk).push(deltaMin);
            managerNameByKey.set(mk, managerKey ? usersMap.get(managerKey) || side.who : side.who || "Не назначен");
          }
          waitingSince = null;
        }
        lastOurAt = at;
        lastOurWho = side.who;
        if (PROMISE_RE.test(t)) {
          lastPromise = { at, excerpt: t.slice(0, 180), who: side.who };
        }
      }
    }

    if (lastPromise) {
      const closed =
        lastOurAt && lastPromise.at && lastOurAt > lastPromise.at && !waitingSince ? false : false;
      // open if after promise there is client wait OR no clear close — keep if promise is among last our meaningful lines
      const stillOpen = !lastClientAt || lastPromise.at <= (lastClientAt || lastPromise.at) || !!waitingSince;
      if (stillOpen || lastOurAt?.getTime() === lastPromise.at.getTime()) {
        openPromises.push({
          id: `prom-${chat.Ref_Key}-${lastPromise.at.getTime()}`,
          client: clientName,
          clientKey: chat.Клиент_Key,
          chat: chat.Description,
          chatKey: chat.Ref_Key,
          manager: managerName || lastPromise.who || "Не назначен",
          managerKey,
          promisedAt: lastPromise.at.toISOString(),
          excerpt: lastPromise.excerpt,
          status: "open",
        });
        if (lastPromise.at >= weekStart && lastPromise.at < weekEnd) {
          dueThisWeek.push({
            id: `due-${chat.Ref_Key}`,
            client: clientName,
            clientKey: chat.Клиент_Key,
            chat: chat.Description,
            chatKey: chat.Ref_Key,
            manager: managerName || lastPromise.who || "Не назначен",
            managerKey,
            dueAt: lastPromise.at.toISOString(),
            kind: "promise",
            excerpt: lastPromise.excerpt,
            status: "open",
          });
        }
      }
      void closed;
    }

    if (waitingSince && lastClientAt && (!lastOurAt || lastClientAt > lastOurAt)) {
      const waitH = (now - waitingSince) / 3600000;
      // только относительно свежие ожидания (до 21 дня), иначе шум
      if (waitH >= 8 && waitH <= 21 * 24) {
        ping.push({
          id: `ping-${chat.Ref_Key}`,
          client: clientName,
          clientKey: chat.Клиент_Key,
          chat: chat.Description,
          chatKey: chat.Ref_Key,
          manager: managerName || lastOurWho || "Не назначен",
          managerKey,
          waitingHours: Math.round(waitH),
          lastClientAt: lastClientAt.toISOString(),
          excerpt: lastClientText.slice(0, 180),
          status: "open",
        });
        dueThisWeek.push({
          id: `owe-${chat.Ref_Key}`,
          client: clientName,
          clientKey: chat.Клиент_Key,
          chat: chat.Description,
          chatKey: chat.Ref_Key,
          manager: managerName || lastOurWho || "Не назначен",
          managerKey,
          dueAt: now.toISOString(),
          kind: "reply",
          excerpt: lastClientText.slice(0, 180),
          status: "open",
        });
      }
    }
  }

  const promByChat = new Map();
  for (const p of openPromises.sort((a, b) => a.promisedAt.localeCompare(b.promisedAt))) {
    promByChat.set(p.chatKey, p);
  }

  const negByChat = new Map();
  for (const n of negativity.sort((a, b) => a.at.localeCompare(b.at))) {
    negByChat.set(n.chatKey, n);
  }

  const managers = [...managerDeltas.entries()]
    .map(([key, arr]) => {
      const avg = arr.reduce((s, x) => s + x, 0) / arr.length;
      const sorted = [...arr].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return {
        managerKey: key === "unknown" ? "" : String(key).includes("-") ? key : "",
        manager: managerNameByKey.get(key) || (key === "unknown" ? "Не назначен" : String(key)),
        replies: arr.length,
        avgMinutes: Math.round(avg * 10) / 10,
        medianMinutes: Math.round(median * 10) / 10,
      };
    })
    .sort((a, b) => a.avgMinutes - b.avgMinutes);

  const faqCandidates = [...faqMap.values()]
    .filter((r) => r.count >= 2 || r.clients.size >= 2)
    .map((r) => ({
      id: `faq-${Buffer.from(r.query).toString("base64url").slice(0, 16)}`,
      query: r.query,
      count: r.count,
      clients: [...r.clients].slice(0, 8),
      suggestion: "Добавить в инструкцию / FAQ",
      status: "open",
    }))
    .sort((a, b) => b.count - a.count || b.clients.length - a.clients.length)
    .slice(0, 25);

  // если мало повторов — показать топ уникальных вопросов как кандидатов
  let faqOut = faqCandidates;
  if (faqOut.length < 5) {
    faqOut = [...faqMap.values()]
      .map((r) => ({
        id: `faq-${Buffer.from(r.query).toString("base64url").slice(0, 16)}`,
        query: r.query,
        count: r.count,
        clients: [...r.clients].slice(0, 8),
        suggestion: "Проверить, нужен ли ответ в инструкции",
        status: "open",
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  }

  const board = {
    generatedAt: new Date().toISOString(),
    source: "seed-odata",
    period: { from: ymd(since), to: ymd(now) },
    week: { from: ymd(weekStart), to: ymd(new Date(weekEnd.getTime() - 1)) },
    stats: {
      chatsScanned: focus.length,
      chatsTotal: chats.length,
      messagesChats: loaded,
      ourContactsMatched: ourContact.size,
    },
    managers,
    openPromises: [...promByChat.values()],
    negativity: [...negByChat.values()],
    dueThisWeek: dueThisWeek.slice(-50),
    ping: ping.sort((a, b) => b.waitingHours - a.waitingHours).slice(0, 40),
    faqCandidates: faqOut,
    events: [
      {
        id: "seed-1",
        type: "board",
        at: new Date().toISOString(),
        source: "seed-odata",
      },
    ],
  };

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "client-quality.json");
  writeFileSync(outPath, JSON.stringify(board, null, 2), "utf8");
  console.log("Wrote", outPath);
  console.log(
    JSON.stringify(
      {
        managers: managers.length,
        openPromises: board.openPromises.length,
        negativity: board.negativity.length,
        dueThisWeek: board.dueThisWeek.length,
        ping: board.ping.length,
        faq: board.faqCandidates.length,
        sampleManager: managers[0],
        samplePromise: board.openPromises[0],
        samplePing: board.ping[0],
        sampleFaq: board.faqCandidates[0],
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
