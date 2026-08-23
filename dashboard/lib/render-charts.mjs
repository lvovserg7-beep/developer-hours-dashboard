const PALETTE = ["#5c6b4a", "#8a5a12", "#3d4a5c", "#9a6b12", "#6b5344", "#7a8a62", "#4a5c6b", "#b08948", "#5a4a3a", "#2f4f4f", "#8a7060"];
const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" });

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colorOf(key, keys) {
  const i = keys.indexOf(key);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

function orderNum(name) {
  const m = String(name || "").match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function allNumbered(names) {
  return names.length > 0 && names.every((n) => orderNum(n) != null);
}

function legendKeys(rows) {
  const set = new Map();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row.segments || {})) {
      set.set(k, (set.get(k) || 0) + v);
    }
  }
  const keys = [...set.keys()];
  if (allNumbered(keys)) {
    return keys.sort((a, b) => orderNum(a) - orderNum(b) || a.localeCompare(b, "ru"));
  }
  return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function hoursTotal(rows) {
  const sum = (rows || []).reduce((s, r) => s + Number(r.total || 0), 0);
  return Math.round(sum * 10) / 10;
}

function stackedChart(title, rows, emptyText) {
  const total = hoursTotal(rows);
  const heading = `${title}: ${total}`;
  if (!rows || !rows.length) {
    return `<h2>${escapeHtml(heading)}</h2><p class="meta">${escapeHtml(emptyText)}</p>`;
  }
  const list = allNumbered(rows.map((r) => r.name))
    ? [...rows].sort((a, b) => orderNum(a.name) - orderNum(b.name) || a.name.localeCompare(b.name, "ru"))
    : rows;
  const keys = legendKeys(list);
  const max = Math.max(...list.map((r) => r.total), 1);
  const legend = keys.map((k) =>
    `<span><i style="background:${colorOf(k, keys)}"></i>${escapeHtml(k)}</span>`
  ).join("");
  const body = list.map((row) => {
    const segs = keys.map((k) => {
      const v = row.segments[k] || 0;
      if (v <= 0) return "";
      const w = (v / max) * 100;
      return `<span class="seg" style="width:${w}%;background:${colorOf(k, keys)}" title="${escapeHtml(k)}: ${v}"></span>`;
    }).join("");
    return `<div class="bar-row">
          <div class="lab" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</div>
          <div class="track">${segs}</div>
          <div class="num">${row.total}</div>
        </div>`;
  }).join("");
  return `<h2>${escapeHtml(heading)}</h2>${body}<div class="legend">${legend}</div>`;
}

function gaugeSvg(value, max) {
  const v = Math.max(0, Math.min(value, max || 1));
  const t = v / (max || 1);
  const start = Math.PI;
  const end = 0;
  const a = start + (end - start) * t;
  const cx = 110, cy = 100, r = 78;
  const nx = cx + r * Math.cos(a);
  const ny = cy - r * Math.sin(a);
  const arc = (from, to, color) => {
    const a1 = start + (end - start) * from;
    const a2 = start + (end - start) * to;
    const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy - r * Math.sin(a2);
    const large = to - from > 0.5 ? 1 : 0;
    return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="14"/>`;
  };
  return `<svg viewBox="0 0 220 128" width="220" height="128" aria-hidden="true">
        ${arc(0, 0.33, "var(--low)")}
        ${arc(0.33, 0.54, "var(--mid)")}
        ${arc(0.54, 1, "var(--high)")}
        <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="var(--ink)" stroke-width="2"/>
        <circle cx="${cx}" cy="${cy}" r="4" fill="var(--ink)"/>
        <text x="32" y="122" font-size="11" fill="var(--muted)">0</text>
        <text x="170" y="122" font-size="11" fill="var(--muted)">${max}</text>
      </svg>`;
}

export function renderChartParts(data) {
  const c = data.charts || {};
  const k = data.kpis || {};
  const when = data.generatedAt ? fmt.format(new Date(data.generatedAt)) : "";
  return {
    meta: `<b>${escapeHtml(data.source || "1С")}</b> · ${when} · в работе ${data.totals?.tasks || 0} задач, ${data.totals?.employees || 0} сотрудников`,
    status: stackedChart("Часов в работе по статусам", c.hoursByStatus, "Нет часов в работе"),
    kpis: `${gaugeSvg(k.hoursCompleted || 0, k.gaugeMax || 1500)}
        <div class="gauge-value">${k.hoursCompleted ?? 0}</div>
        <div class="gauge-caption">Выполнено: ${k.hoursCompleted ?? 0}</div>
        <div class="kpi">Часов в работе: <b>${k.hoursInWork ?? 0}</b></div>
        <div class="kpi">Отложено: <b>${k.hoursPostponed ?? 0}</b></div>`,
    devWork: stackedChart("Часов в работе по разработчикам", c.hoursByDeveloper, "Нет часов разработки в работе"),
    clientDone: stackedChart("Выполненные часы по клиентам", c.completedByClient, "Нет выполненных часов"),
    devDone: stackedChart("Выполненные часы по разработчикам", c.completedByDeveloper, "Нет выполненных часов"),
  };
}
