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
  return `<h2>${escapeHtml(heading)}</h2><div class="bars">${body}</div><div class="legend">${legend}</div>`;
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
  return {
    status: stackedChart("Часов в работе по статусам", c.hoursByStatus, "Нет часов в работе"),
    kpis: `${gaugeSvg(k.hoursCompleted || 0, k.gaugeMax || 1500)}
        <div class="gauge-value">${k.hoursCompleted ?? 0}</div>
        <div class="gauge-caption">Выполнено: ${k.hoursCompleted ?? 0}</div>
        <div class="kpi">Часов в работе: <b>${k.hoursInWork ?? 0}</b></div>
        <div class="kpi">Отложено: <b>${k.hoursPostponed ?? 0}</b></div>`,
    devWork: stackedChart("Часов в работе по разработчикам", c.hoursByDeveloper, "Нет часов разработки в работе"),
    clientDone: stackedChart("Выполненные часы по клиентам", c.completedByClient, "Нет выполненных часов"),
    analystDone: stackedChart("Выполненные часы по аналитикам", c.completedByAnalyst, "Нет выполненных часов"),
    devDone: stackedChart("Выполненные часы по разработчикам", c.completedByDeveloper, "Нет выполненных часов"),
    activity: renderActivityTable(data.activity || []),
    clientOptions: selectOptions(
      uniqueFilterValues((data.activity || []).map((r) => r.client).filter(Boolean)),
      (data.activity || []).some((r) => !r.client) ? { value: "__none__", label: "Без клиента" } : null
    ),
    statusOptions: selectOptions(
      uniqueFilterValues((data.activity || []).map((r) => r.status || "Без статуса"), true)
    ),
  };
}

function uniqueFilterValues(values, numbered = false) {
  const set = [...new Set(values)];
  if (numbered && allNumbered(set)) {
    return set.sort((a, b) => orderNum(a) - orderNum(b) || a.localeCompare(b, "ru"));
  }
  return set.sort((a, b) => a.localeCompare(b, "ru"));
}

function selectOptions(values, extra) {
  let html = `<option value="">Все</option>`;
  if (extra) html += `<option value="${escapeHtml(extra.value)}">${escapeHtml(extra.label)}</option>`;
  for (const value of values) {
    html += `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
  }
  return html;
}

export function renderActivityTable(rows) {
  if (!rows.length) {
    return `<p class="meta">Нет задач с чатом.</p>`;
  }
  const body = rows.map((row) => {
    const date = row.date ? fmt.format(new Date(row.date)) : "—";
    const comment = row.comment
      ? escapeHtml(row.comment).replace(/\n/g, "<br>")
      : `<span class="meta">Нет комментариев</span>`;
    const num = escapeHtml(row.number);
    const link = escapeHtml(row.navLink || "");
    const numberCell = link
      ? `<a class="task-link" href="${link}" data-link="${link}" title="Нажмите, чтобы скопировать ссылку 1С">${num}</a>`
      : `<span class="task-num">${num}</span>`;
    return `<tr>
        <td class="num">${numberCell}</td>
        <td class="title">${escapeHtml(row.title)}</td>
        <td class="client">${escapeHtml(row.client || "Без клиента")}</td>
        <td class="status">${escapeHtml(row.status || "Без статуса")}</td>
        <td class="comment"><div class="comment-body">${comment}</div></td>
        <td class="when">${escapeHtml(date)}</td>
      </tr>`;
  }).join("");
  return `<div class="activity-scroll"><table class="activity">
      <thead>
        <tr>
          <th class="num">Номер</th>
          <th class="title">Задача</th>
          <th class="client">Клиент</th>
          <th class="status">Статус</th>
          <th class="comment">Последний комментарий</th>
          <th class="when">Дата</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="meta tab-intro">Только задачи в работе (порядок статуса 1–6). Сверху самые старые. Всего ${rows.length}. Клик по номеру копирует ссылку 1С.</p>`;
}
