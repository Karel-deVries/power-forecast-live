"use strict";
// Public page: reads data/*.json written by src/export_site.py; live weather comes straight from Open-Meteo.
// Realised prices (ENTSO-E Transparency Platform) are shown when the export includes them (zones.json "actuals").

const TZ = "Europe/Amsterdam";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
// Colours given as CSS variables go into the style, not into presentation attributes: Safari ignores var() in
// fill="..." / stroke="..." attributes, which left the charts empty there.
const STYLE_ATTRS = new Set(["fill", "stroke", "fill-opacity", "stroke-opacity"]);
const svgEl = (tag, attrs) => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) {
    if (STYLE_ATTRS.has(k) && String(attrs[k]).includes("var(")) e.style.setProperty(k, attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  return e;
};
const fmt = (opts) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts });
const fHour = fmt({ hour: "2-digit", minute: "2-digit" });
const fDayHour = fmt({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fDay = fmt({ day: "numeric", month: "short" });
const fDayLong = fmt({ weekday: "long", day: "numeric", month: "long" });
const isoAms = (d) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(d).split("/").reverse().join("-");
const dayDate = (s) => new Date(s + "T12:00:00Z");
const ok = (v) => v !== null && v !== undefined && !Number.isNaN(v);
const num = (v, d = 1) => (ok(v) ? v.toFixed(d) : "–");
const mean = (a) => { const v = a.filter(ok); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const pctTxt = (v) => (ok(v) ? Math.round(v * 100) + "%" : "–");
const KIND = { live: "live", backfill: "backfill", backtest: "backtest" };
const HEADLINE = { timestral: "Timestral", combined: "LEAR + BDT" };   // the model behind the headline forecast
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const dayWord = (date) => {
  const t = isoAms(new Date()), tm = isoAms(new Date(Date.now() + 864e5));
  return date === tm ? "tomorrow" : date === t ? "today" : null;
};

const state = {
  zones: null, zone: null, doc: null, news: null, dayIdx: null, range: 30, levelRange: 365,
  // per chart: series switched off in the legend (the single models start hidden to keep the first view calm)
  hidden: { fc: new Set(["LEAR + BDT", "BDT (trees)"]), rec: new Set(["LEAR + BDT", "BDT (trees)"]), rech: new Set(["LEAR (baseline)"]) },
  drivers: new Set(["demand", "wind"]),
};
// A tap or click outside a chart closes that chart's readout.
document.addEventListener("pointerdown", (e) => {
  document.querySelectorAll(".chart").forEach((c) => { if (c._hideTip && !c.contains(e.target)) c._hideTip(); });
});

/* ---------- line chart: toggleable legend, ranges as bands, crosshair readout, optional crosshair sync ---------- */
function niceTicks(lo, hi, n = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const t = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) t.push(+v.toFixed(6));
  return t;
}

function lineChart(host, cfg) {
  // cfg: {id, labels, xTicks: [{i, text}], series: [{name, color, values, dots} | {name, color, band: true, lo, hi, opacity}],
  //       height, decimals, zeroBased, domain: [lo, hi], ref: {value, text}, shade: {from, to, text}, marker: {i, text},
  //       sync: group name (crosshair follows across charts of the group), title, empty,
  //       selected: {i, text} (a marked point), onPick: (i) => {} (click / tap / Enter on a point),
  //       times: Date per point -> a "now" line that moves with the clock while now lies inside the chart}
  host.textContent = "";
  clearInterval(host._nowTimer);
  host.dataset.sync = cfg.sync || "";
  const id = cfg.id || host.id;
  const hidden = state.hidden[id] || (state.hidden[id] = new Set());
  const pts = cfg.labels.length;
  const valuesOf = (s) => (s.band ? [...s.lo, ...s.hi] : s.values);
  if (!pts || !cfg.series.flatMap(valuesOf).some(ok)) { host.append(el("div", "empty", cfg.empty || "No data yet.")); return; }
  if (cfg.series.length > 1) {
    const lg = el("div", "legend");
    for (const s of cfg.series) {
      const b = el("button", "lg"), key = el("i", s.band ? "swatch" : "key");
      b.type = "button";
      b.setAttribute("aria-pressed", String(!hidden.has(s.name)));
      b.title = "Show or hide";
      if (s.band) { key.style.background = s.color; key.style.opacity = Math.min(1, s.opacity * 3); } else key.style.borderColor = s.color;
      b.append(key, document.createTextNode(s.name));
      b.addEventListener("click", () => {
        if (hidden.has(s.name)) hidden.delete(s.name);
        else if (cfg.series.filter((x) => !hidden.has(x.name)).length > 1) hidden.add(s.name);   // keep one visible
        b.setAttribute("aria-pressed", String(!hidden.has(s.name)));
        draw(true);
      });
      lg.append(b);
    }
    host.append(lg);
  }
  const wrap = el("div");
  wrap.style.position = "relative";
  host.append(wrap);
  const tip = el("div", "tip");
  tip.hidden = true;
  let show = () => {}, hide = () => {};

  const draw = (animate) => {
    wrap.textContent = "";
    const vis = cfg.series.filter((s) => !hidden.has(s.name));
    const vals = vis.flatMap(valuesOf).filter(ok).concat(cfg.ref ? [cfg.ref.value] : []);
    const W = Math.max(280, wrap.clientWidth || host.clientWidth || 600), H = cfg.height || 240;
    const m = { l: 44, r: 12, t: 10, b: 26 };
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (cfg.zeroBased) lo = Math.min(0, lo);
    if (cfg.domain) [lo, hi] = cfg.domain;
    const ticks = niceTicks(lo, hi);
    if (!cfg.domain) { lo = ticks[0]; hi = ticks[ticks.length - 1]; }
    const x = (i) => m.l + (pts === 1 ? 0.5 : i / (pts - 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0",
      "aria-label": (cfg.title || "Line chart") + ". Use the arrow keys to read values." });
    for (const t of ticks) {
      if (t < lo - 1e-9 || t > hi + 1e-9) continue;
      svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
      const lab = svgEl("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end" });
      lab.textContent = t.toLocaleString("en-GB");
      svg.append(lab);
    }
    let lastEnd = -Infinity;
    for (const t of cfg.xTicks) {
      const half = t.text.length * 3.2;
      if (x(t.i) - half < lastEnd + 6 || x(t.i) + half > W) continue;   // skip labels that would collide
      lastEnd = x(t.i) + half;
      const lab = svgEl("text", { x: x(t.i), y: H - 8, "text-anchor": "middle" });
      lab.textContent = t.text;
      svg.append(lab);
    }
    if (cfg.shade && cfg.shade.to >= 0 && cfg.shade.from < pts) {
      const b0 = x(Math.max(0, cfg.shade.from)), b1 = x(Math.min(pts - 1, cfg.shade.to));
      svg.append(svgEl("rect", { x: b0, y: m.t, width: Math.max(0, b1 - b0), height: H - m.t - m.b, fill: "var(--ink)", "fill-opacity": 0.06 }));
      const lab = svgEl("text", { x: b0 + 5, y: m.t + 11, class: "mark-label" });
      lab.textContent = cfg.shade.text;
      svg.append(lab);
    }
    if (cfg.marker && cfg.marker.i > 0 && cfg.marker.i < pts) {
      const mx = x(cfg.marker.i - 0.5);
      svg.append(svgEl("line", { x1: mx, x2: mx, y1: m.t, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1 }));
      const right = mx > W - m.r - 110;   // near the right edge: label to the left of the line
      const lab = svgEl("text", { x: right ? mx - 5 : mx + 5, y: m.t + 10, class: "mark-label", "text-anchor": right ? "end" : "start" });
      lab.textContent = cfg.marker.text;
      svg.append(lab);
    }
    if (cfg.selected && cfg.selected.i >= 0) {
      const sx = x(cfg.selected.i), right = sx > W - m.r - 80;
      svg.append(svgEl("line", { x1: sx, x2: sx, y1: m.t, y2: H - m.b, stroke: "var(--ink-2)", "stroke-width": 1 }));
      const lab = svgEl("text", { x: right ? sx - 5 : sx + 5, y: m.t + 10, class: "mark-label", "text-anchor": right ? "end" : "start" });
      lab.textContent = cfg.selected.text;
      svg.append(lab);
    }
    const fades = [], lines = [];
    for (const s of vis.filter((s) => s.band)) {   // ranges first, under the lines
      let d = "";
      const seg = [];
      const flush = () => {
        if (seg.length) d += "M" + seg.map((i) => `${x(i).toFixed(1)},${y(s.hi[i]).toFixed(1)}`).join("L") +
          "L" + [...seg].reverse().map((i) => `${x(i).toFixed(1)},${y(s.lo[i]).toFixed(1)}`).join("L") + "Z";
        seg.length = 0;
      };
      s.lo.forEach((v, i) => (ok(v) && ok(s.hi[i]) ? seg.push(i) : flush()));
      flush();
      const p = svgEl("path", { d, fill: s.color, "fill-opacity": s.opacity, stroke: "none" });
      svg.append(p);
      fades.push(p);
    }
    if (cfg.ref) {
      svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(cfg.ref.value), y2: y(cfg.ref.value), stroke: "var(--ink-2)", "stroke-width": 1 }));
      const lab = svgEl("text", { x: W - m.r - 4, y: y(cfg.ref.value) - 5, "text-anchor": "end", class: "mark-label" });
      lab.textContent = cfg.ref.text;
      svg.append(lab);
    }
    const lineSeries = vis.filter((s) => !s.band);
    for (const s of lineSeries) {
      let d = "", pen = false;
      s.values.forEach((v, i) => {
        if (!ok(v)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      const p = svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
      svg.append(p);
      lines.push(p);
    }
    for (const s of lineSeries) {
      (s.dots || []).forEach((kind, i) => {
        const v = s.values[i];
        if (!kind || !ok(v)) return;
        svg.append(svgEl("circle", { cx: x(i), cy: y(v), r: 4, fill: kind === "fill" ? s.color : "var(--surface)",
          stroke: kind === "fill" ? "var(--surface)" : s.color, "stroke-width": 2 }));
      });
    }
    if (cfg.times && cfg.times.length === pts) {   // live "now" line, placed between hourly points by the minute
      const nl = svgEl("line", { y1: m.t, y2: H - m.b, stroke: "var(--warning)", "stroke-width": 1.5 });
      const nt = svgEl("text", { y: m.t + 10, class: "mark-label" });
      nt.textContent = "now";
      svg.append(nl, nt);
      const place = () => {
        const t = Date.now(), ts = cfg.times.map((d) => d.getTime());
        const k = ts.findIndex((v, j) => j < pts - 1 && v <= t && t < ts[j + 1]);
        const span = ts[pts - 1] - ts[pts - 2] || 3600e3;
        const pos = k >= 0 ? k + (t - ts[k]) / (ts[k + 1] - ts[k]) : t >= ts[pts - 1] && t < ts[pts - 1] + span ? pts - 1 : -1;
        const vis = pos >= 0 ? "visible" : "hidden", nx = pos >= 0 ? x(pos) : 0, right = nx > W - m.r - 40;
        nl.setAttribute("x1", nx); nl.setAttribute("x2", nx); nl.setAttribute("visibility", vis);
        nt.setAttribute("x", right ? nx - 5 : nx + 5); nt.setAttribute("text-anchor", right ? "end" : "start"); nt.setAttribute("visibility", vis);
      };
      place();
      clearInterval(host._nowTimer);
      host._nowTimer = setInterval(place, 30000);
    }
    const hair = svgEl("line", { y1: m.t, y2: H - m.b, stroke: "var(--ink-2)", "stroke-width": 1, visibility: "hidden" });
    svg.append(hair);
    const dots = lineSeries.map((s) => {
      const c = svgEl("circle", { r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
      svg.append(c);
      return c;
    });
    wrap.append(svg, tip);

    if (animate && !reduceMotion) {   // lines draw themselves in, ranges fade in
      for (const p of lines) {
        const L = p.getTotalLength();
        p.style.strokeDasharray = L; p.style.strokeDashoffset = L;
        p.getBoundingClientRect();
        p.style.transition = "stroke-dashoffset 700ms ease-out";
        p.style.strokeDashoffset = 0;
      }
      for (const p of fades) {
        p.style.opacity = 0;
        p.getBoundingClientRect();
        p.style.transition = "opacity 600ms ease-out";
        p.style.opacity = 1;
      }
    }

    let cur = -1;
    show = (i, withTip = true) => {
      cur = Math.max(0, Math.min(pts - 1, i));
      hair.setAttribute("x1", x(cur)); hair.setAttribute("x2", x(cur)); hair.setAttribute("visibility", "visible");
      lineSeries.forEach((s, k) => {
        const v = s.values[cur];
        if (!ok(v)) { dots[k].setAttribute("visibility", "hidden"); return; }
        dots[k].setAttribute("cx", x(cur)); dots[k].setAttribute("cy", y(v)); dots[k].setAttribute("visibility", "visible");
      });
      if (!withTip) { tip.hidden = true; return; }
      tip.textContent = "";
      tip.append(el("div", "t", cfg.labels[cur]));
      for (const s of vis) {
        const row = el("div", "row");
        if (s.band) {
          if (!ok(s.lo[cur])) continue;
          const key = el("i", "swatch");
          key.style.background = s.color; key.style.opacity = Math.min(1, s.opacity * 3);
          row.append(key, el("b", "", `${num(s.lo[cur], 0)}–${num(s.hi[cur], 0)}`), el("span", "n", s.name));
        } else {
          if (!ok(s.values[cur])) continue;
          const key = el("i", "key");
          key.style.borderColor = s.color;
          row.append(key, el("b", "", num(s.values[cur], cfg.decimals ?? 1)), el("span", "n", s.name));
        }
        tip.append(row);
      }
      tip.hidden = false;
      const tw = tip.offsetWidth, px = x(cur) * (wrap.clientWidth / W);
      tip.style.left = Math.max(0, Math.min(wrap.clientWidth - tw, px + 14 + tw > wrap.clientWidth ? px - tw - 14 : px + 14)) + "px";
    };
    hide = () => { tip.hidden = true; hair.setAttribute("visibility", "hidden"); dots.forEach((c) => c.setAttribute("visibility", "hidden")); };
    const peers = () => (cfg.sync ? [...document.querySelectorAll(`.chart[data-sync="${cfg.sync}"]`)].filter((h) => h !== host && h._sync) : []);
    const at = (e) => {
      const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
      const i = Math.round(((px - m.l) / (W - m.l - m.r)) * (pts - 1));
      show(i);
      peers().forEach((h) => h._sync.show(i));
    };
    svg.addEventListener("pointermove", at);
    svg.addEventListener("pointerdown", at);   // a tap on a phone shows the values at that point
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { hide(); peers().forEach((h) => h._sync.hide()); } });
    svg.addEventListener("focus", () => { if (svg.matches(":focus-visible")) show(cur < 0 ? pts - 1 : cur); });
    svg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { show(cur + (e.key === "ArrowRight" ? 1 : -1)); e.preventDefault(); }
      if (e.key === "Enter" && cfg.onPick && cur >= 0) cfg.onPick(cur);
    });
    if (cfg.onPick) {
      svg.style.cursor = "pointer";
      svg.addEventListener("click", (e) => { at(e); if (cur >= 0) cfg.onPick(cur); });
    }
  };
  draw(cfg.animate !== false);
  host._sync = { show: (i) => show(i, false), hide: () => hide() };
  host._hideTip = () => { hide(); };
  let width = wrap.clientWidth;
  new ResizeObserver(() => { if (wrap.clientWidth !== width) { width = wrap.clientWidth; draw(false); } }).observe(wrap);
}

function tiles(host, items) {
  host.textContent = "";
  for (const [value, unit, label] of items) {
    const t = el("div", "tile"), v = el("div", "v", value);
    if (unit) v.append(" ", el("small", "", unit));
    t.append(v, el("div", "k", label));
    host.append(t);
  }
}

function segmented(id, current, onPick) {
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.setAttribute("aria-pressed", String(+b.dataset.v === current));
    b.onclick = () => {
      document.querySelectorAll(`#${id} button`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      onPick(+b.dataset.v);
    };
  });
}

/* ---------- all zones ---------- */
function renderOverview() {
  const zs = state.zones.zones.filter((z) => z.summary && ok(z.summary.mean));
  const host = $("ov-chart");
  host.textContent = "";
  if (!zs.length) return;
  const dates = zs.map((z) => z.summary.date).sort(), date = dates[dates.length - 1];
  const word = dayWord(date);
  $("ov-title").textContent = `All zones: forecast for ${word ? word + ", " : ""}${fDayLong.format(dayDate(date))}`;
  const late = zs.filter((z) => z.summary.date === date && z.summary.late).length;
  const behind = zs.filter((z) => z.summary.date !== date).map((z) => z.code);
  $("ov-note").textContent = "Each row is one bidding zone: the line runs from the cheapest to the most expensive hour, the dot is the day's average. " +
    "The 30-day error is the headline forecast's average miss per hour, with the change compared with LEAR, the standard benchmark" +
    (zs.some((z) => (z.summary.backfill_share || 0) > 0.5) ? " (mostly computed afterwards, before Timestral ran live)" : "") + ". Select a row for the details. " +
    (late ? `${late === zs.length ? "All" : late} of these forecasts ${late === 1 ? "was" : "were"} made after the auction had closed (the daily job started late). ` : "") +
    (behind.length ? `Not yet updated: ${behind.join(", ")} (showing an older day).` : "");
  const lo0 = Math.min(...zs.map((z) => z.summary.min)), hi0 = Math.max(...zs.map((z) => z.summary.max));
  const ticks = niceTicks(lo0, hi0, 5), lo = ticks[0], hi = ticks[ticks.length - 1];   // a dot-range plot needs no zero baseline
  const pct = (v) => ((v - lo) / (hi - lo)) * 100 + "%";
  const key = el("div", "ov-key"), k1 = el("span"), k2 = el("span");
  k1.append(el("i", "k-dot"), document.createTextNode("day average"));
  k2.append(el("i", "k-rng"), document.createTextNode("cheapest to most expensive hour"));
  key.append(k1, k2, el("span", "", "€/MWh"));
  const axis = el("div", "ov-axis"), track = el("div", "track");
  for (const t of ticks) {
    const lab = el("span", "tick", t.toLocaleString("en-GB"));
    lab.style.left = pct(t);
    track.append(lab);
  }
  axis.append(el("span"), track, el("span"));
  host.append(key, axis);
  for (const z of [...zs].sort((a, b) => b.summary.mean - a.summary.mean)) {
    const s = z.summary, row = el("button", "ov-row");
    row.type = "button";
    row.dataset.zone = z.code;
    row.setAttribute("aria-pressed", String(z.code === state.zone));
    row.setAttribute("aria-label", `${z.name}: average ${num(s.mean, 0)}, lowest hour ${num(s.min, 0)}, highest hour ${num(s.max, 0)} euro per megawatt hour` +
      (s.date !== date ? `, forecast for ${s.date}` : ""));
    const name = el("span", "zn", z.name);
    if (ok(s.mae_headline)) {
      const rel = Math.round((s.mae_headline / s.mae_lear - 1) * 100);
      name.append(el("small", "", `30-day error ${num(s.mae_headline, 0)} (${rel < 0 ? "−" + -rel : "+" + rel}% vs LEAR)`));
    }
    const tr = el("span", "track");
    for (const t of ticks) { const g = el("i", "grid"); g.style.left = pct(t); tr.append(g); }
    const rng = el("i", "rng");
    rng.style.left = pct(s.min);
    rng.style.width = `calc(${pct(s.max)} - ${pct(s.min)})`;
    const dot = el("i", "dot");
    dot.style.left = pct(s.mean);
    tr.append(rng, dot);
    const val = el("span", "vv", num(s.mean, 0));
    val.append(el("small", "", s.date !== date ? `for ${fDay.format(dayDate(s.date))}` : `${num(s.min, 0)} – ${num(s.max, 0)}`));
    row.append(name, tr, val);
    row.addEventListener("click", () => { $("zone").value = z.code; loadZone(z.code); });
    host.append(row);
  }
}

/* ---------- forecast for one delivery day (navigable), with ranges and the model inputs ---------- */
const DRIVERS = [
  { key: "demand", name: "Demand forecast", unit: "GW", dec: 2 },
  { key: "wind", name: "Wind speed at 100 m", unit: "m/s", dec: 1, zero: true },
  { key: "sun", name: "Solar radiation", unit: "W/m²", dec: 0, zero: true },
  { key: "temp", name: "Temperature", unit: "°C", dec: 1 },
];

function renderForecast(animate = true) {
  const days = state.doc.hourly, i = state.dayIdx ?? days.length - 1, f = days[i], latest = i === days.length - 1;
  const rec = state.doc.days.find((d) => d.date === f.date);
  const times = f.ts_utc.map((t) => new Date(t)), w = dayWord(f.date);
  $("fc-title").textContent = `${state.doc.name}: forecast for ${w ? w + ", " : ""}${fDayLong.format(dayDate(f.date))}`;
  $("day-prev").disabled = i === 0;
  $("day-next").disabled = latest;
  $("day-label").textContent = latest ? "newest" : `${days.length - 1 - i} day${days.length - 1 - i === 1 ? "" : "s"} back`;

  const notes = [], model = HEADLINE[f.headline_model] || "LEAR + BDT";
  if (f.headline_kind === "live") notes.push(`${model} forecast made ${fDayHour.format(new Date(f.headline_issued_at))} (Amsterdam time), ${f.late ? "after" : "before"} the auction closed.`);
  else if (f.kind === "live") notes.push(`LEAR and the BDT were made live (${fDayHour.format(new Date(f.issued_at))}); ${model} was added afterwards with the same inputs (backfill).`);
  else notes.push("Computed afterwards with the live setup (backfill).");
  if (f.missing_labels && f.missing_labels.length) notes.push(`Made without inputs that were not published in time: ${[...new Set(f.missing_labels)].join(", ")}.`);
  if (latest) {
    const st = state.zones.status, zs = st && st.zones[state.zone];
    if (zs && st.date !== f.date && zs.startsWith("waiting")) notes.push(`The forecast for ${fDayLong.format(dayDate(st.date))} is waiting for data that has not been published yet; it is retried automatically.`);
    else if (zs && zs.startsWith("failed")) notes.push("The last run for this zone failed; it is retried automatically.");
    if (w === "today") notes.push("This is today's forecast; tomorrow's appears after the morning run.");
    if (f.kind === "live" && !state.doc.latest.inputs.news) notes.push("Made without that morning's news scores.");
  }
  if (rec && ok(rec.in80)) {
    const n = f.ts_utc.length;
    notes.push(`Result: the price was inside the 80% range in ${Math.round(rec.in80 * n)} of ${n} hours.`);
  }
  $("fc-status").textContent = notes.join(" ");

  const c = f.headline, valid = c.filter(ok), iMax = c.indexOf(Math.max(...valid)), iMin = c.indexOf(Math.min(...valid));
  const summ = (state.zones.zones.find((z) => z.code === state.zone) || {}).summary;
  tiles($("fc-tiles"), [
    [num(mean(c), 0), "€/MWh", "average of the day"],
    [num(c[iMax], 0), "€/MWh", `highest hour, ${fHour.format(times[iMax])}`],
    [num(c[iMin], 0), "€/MWh", `lowest hour, ${fHour.format(times[iMin])}`],
    [summ && ok(summ.mae_headline) ? "±" + num(summ.mae_headline, 0) : "–", "€/MWh", "typical miss per hour (last 30 days)"],
  ]);

  const labels = times.map((t) => fDayHour.format(t)), xTicks = times.map((t, k) => ({ i: k, text: fHour.format(t) })).filter((_, k) => k % 3 === 0);
  const series = [
    { name: f.headline_model === "timestral" ? "Timestral (headline)" : "LEAR + BDT (headline)", color: "var(--combined)", values: f.headline },
    { name: "LEAR (baseline)", color: "var(--lear)", values: f.lear },
    ...(f.headline_model === "timestral" ? [{ name: "LEAR + BDT", color: "var(--mix)", values: f.combined }] : []),
    { name: "BDT (trees)", color: "var(--bdt)", values: f.bdt },
    ...(f.actual && f.actual.some(ok) ? [{ name: "Realised price", color: "var(--ink)", values: f.actual }] : []),
  ];
  if (f.band) {
    series.push({ name: "50% range", color: "var(--combined)", band: true, lo: f.band.q25, hi: f.band.q75, opacity: 0.24 });
    series.push({ name: "80% range", color: "var(--combined)", band: true, lo: f.band.q10, hi: f.band.q90, opacity: 0.12 });
  }
  state.fcTimes = times;   // the moving "now" line shows while the shown day is today
  lineChart($("fc-chart"), { id: "fc", title: "Hourly price forecast", labels, xTicks, height: 300, series, sync: "fc", animate, times });

  // Model inputs: chips switch panels on and off; the panels share the price chart's crosshair.
  const chips = $("drv-chips");
  chips.querySelectorAll(".chip").forEach((x) => x.remove());
  for (const d of DRIVERS) {
    const b = el("button", "chip", d.name);
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.drivers.has(d.key)));
    b.addEventListener("click", () => {
      state.drivers.has(d.key) ? state.drivers.delete(d.key) : state.drivers.add(d.key);
      renderDrivers(f, labels, xTicks);
      b.setAttribute("aria-pressed", String(state.drivers.has(d.key)));
    });
    chips.append(b);
  }
  renderDrivers(f, labels, xTicks);

  const table = el("table"), head = el("tr");
  ["Hour", model, "80% range", "LEAR", "LEAR + BDT", "BDT", "Demand GW", "Wind m/s", "Sun W/m²", "Temp °C"].forEach((h) => head.append(el("th", "", h)));
  table.append(head);
  times.forEach((t, k) => {
    const tr = el("tr"), dv = f.drivers || {};
    [fHour.format(t), num(f.headline[k]), f.band ? `${num(f.band.q10[k], 0)}–${num(f.band.q90[k], 0)}` : "–", num(f.lear[k]), num(f.combined[k]), num(f.bdt[k]),
      num((dv.demand || [])[k], 2), num((dv.wind || [])[k]), num((dv.sun || [])[k], 0), num((dv.temp || [])[k])].forEach((v) => tr.append(el("td", "", v)));
    table.append(tr);
  });
  $("fc-table").textContent = "";
  $("fc-table").append(table);
}

function renderDrivers(f, labels, xTicks) {
  const host = $("drv-panels");
  host.textContent = "";
  const zone = state.zones.zones.find((z) => z.code === state.zone);
  for (const d of DRIVERS.filter((x) => state.drivers.has(x.key))) {
    const box = el("div", "drv"), chart = el("div", "chart");
    chart.id = "drv-" + d.key;
    box.append(el("h3", "", `${d.name}, ${d.unit}`), chart);
    host.append(box);
    lineChart(chart, { title: d.name, labels, xTicks, height: 130, decimals: d.dec, zeroBased: d.zero, sync: "fc", times: state.fcTimes,
      series: [{ name: d.name, color: "var(--ink-2)", values: (f.drivers || {})[d.key] || [] }] });
  }
  $("drv-note").textContent = state.drivers.size
    ? `What the models saw for this day: the grid operator's demand forecast for ${zone.name}, and the weather as forecast two days ahead, ` +
      `averaged over ${zone.weather.map((p) => p.name.replace(/_/g, " ")).join(", ")}.`
    : "";
}

/* ---------- track record ---------- */
function renderRecord(animate = true) {
  // Only multi-day averages are published (a single day's error would reveal that day's average price):
  // per day the 7-day rolling average, plus totals over the last 14 / 30 / 90 / all days and the live days.
  const all = state.doc.days.filter((d) => d.mae7 || ok(d.in80)), days = state.range ? all.slice(-state.range) : all;
  const agg = state.doc.agg || {}, a = agg[state.range ? String(state.range) : "all"] || {}, lv = agg.live || { days: 0 };
  tiles($("rec-tiles"), [
    [num(a.timestral), "€/MWh", `Timestral's average miss per hour, ${state.range ? "last " + a.days + " days" : "all " + a.days + " days"} with a Timestral forecast`],
    [ok(a.timestral) && a.lear ? Math.round((a.timestral / a.lear - 1) * 100) + "%" : "–", "", "compared with LEAR on the same days"],
    [pctTxt(a.in80), "", "of hours inside the 80% range (should be about 80%)"],
    [ok(lv.timestral) ? num(lv.timestral) : "–", ok(lv.timestral) ? "€/MWh" : "",
      `live forecasts only (${lv.days} day${lv.days === 1 ? "" : "s"}` + (lv.days < 7 ? "; shown from 7 days" : "") +
      (lv.late ? `, ${lv.late} made after the auction closed` : "") + (lv.incomplete ? `, ${lv.incomplete} with an input missing` : "") + ")"],
  ]);
  const kinds = new Set(days.map((d) => d.kind));
  $("rec-note").textContent = "How far the forecasts were off, per hour, averaged over 7 days (each point covers that day and the 6 before it). " +
    (kinds.has("backfill") ? "Backfill days were computed afterwards with the live setup. " : "") +
    (kinds.has("live") ? "Dots mark live forecasts: filled = made before the auction closed, open = made after it. " : "") +
    (ok(a.in80) && a.in80 < 0.75 ? "The ranges have been too narrow lately: prices moved more than in the weeks before." : "");
  const firstNew = days.findIndex((d) => d.kind === "live");
  const labels = days.map((d) => `7 days to ${fDay.format(dayDate(d.date))} · ${KIND[d.kind]}${d.late ? ", after the auction" : ""}${d.incomplete ? ", input missing" : ""}`);
  const xTicks = days.map((d, i) => ({ i, text: fDay.format(dayDate(d.date)) })).filter((_, i) => i % Math.ceil(days.length / 8) === 0);
  const m7 = (k) => days.map((d) => (d.mae7 ? d.mae7[k] ?? null : null));
  lineChart($("rec-daily"), {
    id: "rec", title: "Average miss per hour, 7-day average", labels, xTicks, height: 220, zeroBased: true, animate,
    marker: firstNew > 0 ? { i: firstNew, text: "live from here" } : null,
    series: [
      { name: "Timestral (headline)", color: "var(--combined)", values: m7("timestral"),
        dots: days.map((d) => (d.kind !== "live" ? null : d.late ? "hollow" : "fill")) },
      { name: "LEAR (baseline)", color: "var(--lear)", values: m7("lear") },
      { name: "LEAR + BDT", color: "var(--mix)", values: m7("combined") },
      { name: "BDT (trees)", color: "var(--bdt)", values: m7("bdt") },
    ],
  });
  // Hour by hour: realised price against the forecasts, over the chosen period (the page holds the last 30 days).
  const hd = state.doc.hourly.filter((h) => h.actual && h.actual.some(ok)).slice(-(state.range && state.range < 30 ? state.range : 30));
  $("rec-hourly-wrap").hidden = !hd.length;
  if (hd.length) {
    $("rec-hourly-title").textContent = `Forecast and realised price per hour, last ${hd.length} days, €/MWh`;
    const ts = hd.flatMap((h) => h.ts_utc.map((t) => new Date(t)));
    const cat = (k) => hd.flatMap((h) => h[k] || h.ts_utc.map(() => null));
    lineChart($("rec-hourly"), {
      id: "rech", title: "Forecast and realised price per hour", labels: ts.map((t) => fDayHour.format(t)), height: 260, animate,
      xTicks: ts.map((t, i) => ({ i, text: fDay.format(t) })).filter((t, i) => fHour.format(ts[i]) === "12:00" && (hd.length <= 14 || i % 72 < 24)),
      series: [
        { name: "Realised price", color: "var(--ink)", values: cat("actual") },
        { name: "Timestral (headline)", color: "var(--combined)", values: cat("timestral") },
        { name: "LEAR (baseline)", color: "var(--lear)", values: cat("lear") },
        { name: "80% range", color: "var(--combined)", band: true, lo: hd.flatMap((h) => (h.band ? h.band.q10 : h.ts_utc.map(() => null))),
          hi: hd.flatMap((h) => (h.band ? h.band.q90 : h.ts_utc.map(() => null))), opacity: 0.12 },
      ],
    });
  }
  const off = all.length - days.length;   // 7-day average over all days, so the first shown days use the days before them
  const roll = days.map((_, i) => mean(all.slice(Math.max(0, off + i - 6), off + i + 1).map((d) => d.in80)));
  lineChart($("rec-cover"), {
    id: "cover", title: "Hours inside the 80% range", labels, xTicks, height: 170, domain: [0, 100], decimals: 0, animate,
    ref: { value: 80, text: "aim: 80%" }, series: [{ name: "Inside the 80% range", color: "var(--combined)", values: roll.map((v) => (ok(v) ? v * 100 : null)) }],
  });
  const table = el("table"), head = el("tr");
  ["Delivery day", "Type", "Timestral, 7 days", "LEAR, 7 days", "LEAR + BDT, 7 days", "BDT, 7 days", "In 80% range", "Notes"].forEach((h) => head.append(el("th", "", h)));
  table.append(head);
  for (const d of [...days].reverse()) {
    const tr = el("tr"), q = d.mae7 || {};
    [fDay.format(dayDate(d.date)), KIND[d.kind], num(q.timestral), num(q.lear), num(q.combined), num(q.bdt), pctTxt(d.in80),
      [d.model !== "timestral" && "headline: LEAR + BDT", d.late && "after the auction", d.incomplete && "input missing"].filter(Boolean).join(", ")].forEach((v) => tr.append(el("td", "", v)));
    table.append(tr);
  }
  $("rec-table").textContent = "";
  $("rec-table").append(table);
}

/* ---------- live weather (browser -> Open-Meteo) ---------- */
async function renderWeather() {
  const z = state.zones.zones.find((x) => x.code === state.zone), code = state.zone;
  const names = z.weather.map((w) => w.name.replace(/_/g, " ")).join(", ");
  $("wx-note").textContent = "Loading from Open-Meteo…";
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + z.weather.map((w) => w.lat).join(",") +
      "&longitude=" + z.weather.map((w) => w.lon).join(",") +
      "&hourly=temperature_2m,wind_speed_100m,shortwave_radiation&wind_speed_unit=ms&past_days=1&forecast_days=3&timezone=UTC";
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    let data = await res.json();
    if (code !== state.zone) return;   // the visitor switched zone meanwhile
    if (!Array.isArray(data)) data = [data];
    const times = data[0].hourly.time.map((t) => new Date(t + "Z")), now = Date.now();
    const keep = times.map((t, i) => (t >= now - 12 * 3600e3 && t <= now + 48 * 3600e3 ? i : -1)).filter((i) => i >= 0);   // 12 h back: "now" sits inside
    const avg = (k) => keep.map((i) => mean(data.map((p) => p.hourly[k][i])));
    const labels = keep.map((i) => fDayHour.format(times[i]));
    const xTicks = keep.map((i, j) => ({ i: j, text: fmt({ weekday: "short", day: "numeric", month: "short" }).format(times[i]) }))
      .filter((t, j) => fHour.format(times[keep[j]]) === "12:00");
    const fdate = state.doc.latest.date, inDay = keep.map((i) => isoAms(times[i]) === fdate);
    const shade = inDay.filter(Boolean).length >= 6 ? { from: inDay.indexOf(true), to: inDay.lastIndexOf(true), text: "forecast day" } : null;   // not for a sliver
    const one = (id, k, name) => lineChart($(id), { title: name, labels, xTicks, height: 190, zeroBased: k !== "temperature_2m",
      shade, times: keep.map((i) => times[i]), series: [{ name, color: "var(--combined)", values: avg(k) }] });
    one("wx-wind", "wind_speed_100m", "Wind speed");
    one("wx-sun", "shortwave_radiation", "Solar radiation");
    one("wx-temp", "temperature_2m", "Temperature");
    $("wx-note").textContent = `Left of the "now" line: the past 12 hours; right of it: the newest forecast for the coming 48 hours, fetched just now from Open-Meteo, averaged over the zone's weather points: ${names}. ` +
      "The price models use the forecast as it stood two days before delivery (see the model inputs above).";
  } catch (e) {
    $("wx-note").textContent = "The weather forecast could not be loaded from Open-Meteo right now.";
    ["wx-wind", "wx-sun", "wx-temp"].forEach((id) => { $(id).textContent = ""; });
  }
}

/* ---------- news ---------- */
const TOPIC = { gas_supply: "gas supply", power_supply: "power supply", geopolitics: "geopolitics" };
const EFFECT = { up: "↑ prices up", down: "↓ prices down", none: "no clear effect" };

function renderNews() {
  const n = state.news, s = n.scores;
  if (!state.newsDay) state.newsDay = n.latest ? n.latest.date : s.length ? s[s.length - 1].date : null;
  const sel = s.findIndex((d) => d.date === state.newsDay);
  lineChart($("news-chart"), {
    id: "news", title: "News scores per day", labels: s.map((d) => fDay.format(dayDate(d.date))), height: 200, decimals: 0,
    selected: sel >= 0 ? { i: sel, text: "shown below" } : null, animate: !state.newsRendered,
    onPick: (i) => { state.newsDay = s[i].date; renderNews(); renderNewsImpact(); },
    xTicks: s.map((d, i) => ({ i, text: fDay.format(dayDate(d.date)) })).filter((_, i) => i % 7 === 0),
    series: [
      { name: "Gas supply", color: "var(--combined)", values: s.map((d) => d.gas_tension) },
      { name: "Power supply", color: "var(--lear)", values: s.map((d) => d.power_tension) },
      { name: "Geopolitics (pointing up only)", color: "var(--bdt)", values: s.map((d) => d.shock) },
    ],
  });
  state.newsRendered = true;
  $("news-list").textContent = ""; $("news-rest").textContent = "";
  const score = s.find((d) => d.date === state.newsDay), day = (n.days || {})[state.newsDay] || null;
  if (!score) return;
  $("news-day-title").textContent = `Delivery day ${fDayLong.format(dayDate(score.date))}`;
  const sign = (v) => (v > 0 ? "+" + v : String(v));
  tiles($("news-tiles"), [
    [sign(score.gas_tension), "", "gas supply: up minus down"],
    [sign(score.power_tension), "", "power supply: up minus down"],
    [String(score.shock), "", "geopolitics pointing up"],
    [score.n_headlines !== undefined ? String(score.n_headlines) : "–", "", "headlines read"],
  ]);
  $("news-summary").textContent = score.summary;
  if (!day) {
    $("news-note").textContent = "For this day only the scores were stored; the individual headlines and their labels are kept for days from the live start (1 November 2026) on.";
    $("news-rest-wrap").hidden = true;
    return;
  }
  $("news-note").textContent = `Headlines published in the 24 hours before the auction for this day, from ${day.files_used} of ` +
    `${day.files_total} GDELT snapshots. A small language model labels each headline; only the counts feed the price models. ` +
    "The one-line summary is written by the model and can be wrong.";
  for (const it of day.items) {
    const li = el("li"), ttl = el("span", "title", it.title);
    ttl.title = it.title;
    li.append(ttl);
    if (it.topic) li.append(el("span", "tag", TOPIC[it.topic] || it.topic), el("span", "tag", EFFECT[it.effect] || it.effect));
    (it.topic && it.effect && it.effect !== "none" ? $("news-list") : $("news-rest")).append(li);   // only headlines that move prices
  }
  if (!$("news-list").children.length) $("news-list").append(el("li", "muted", "No headline points clearly to higher or lower prices for this day."));
  $("news-rest-wrap").hidden = !$("news-rest").children.length;
}

/* ---------- news impact on the BDT (the model that uses the news scores) ---------- */
function renderNewsImpact() {
  if (!state.doc || !state.news) return;
  const dates = state.news.scores.map((d) => d.date), byDate = Object.fromEntries(state.doc.days.map((d) => [d.date, d]));
  const rows = dates.map((d) => byDate[d] || {});
  const zone = state.doc.name;
  $("nimp-title").textContent = `What the news did to the forecasts for ${zone}`;
  const scored = rows.filter((d) => ok(d.news_gain)).slice(-30);
  const helped = scored.filter((d) => d.news_gain > 0.05).length, hurt = scored.filter((d) => d.news_gain < -0.05).length;
  tiles($("nimp-tiles"), [
    [scored.length ? num(mean(scored.map((d) => Math.abs(d.news_push))), 1) : "–", "€/MWh", "average push of the news on the BDT forecast (last 30 days)"],
    [scored.length ? (mean(scored.map((d) => d.news_gain)) >= 0 ? "+" : "") + num(mean(scored.map((d) => d.news_gain)), 2) : "–", "€/MWh",
      "error reduction per hour thanks to the news (negative = the news made it worse)"],
    [scored.length ? `${helped} / ${hurt}` : "–", "", "days the news helped / hurt (rest: no real difference)"],
  ]);
  const sel = dates.indexOf(state.newsDay), day = byDate[state.newsDay];
  let txt = "The BDT is the model that uses the news scores (Timestral does not; LEAR only a little). For every hour its " +
    "forecast can be split exactly into contributions per input (TreeSHAP); the 'push' is what the news inputs added, and " +
    "the error reduction compares the BDT's error with and without that push against the realised price. ";
  if (day && ok(day.news_push)) {
    txt += `On ${fDayLong.format(dayDate(state.newsDay))} the news moved the BDT forecast by ${day.news_push >= 0 ? "+" : ""}${num(day.news_push, 1)} €/MWh on average` +
      (ok(day.news_gain) ? (Math.abs(day.news_gain) <= 0.05 ? ", which made no real difference to its error." :
        day.news_gain > 0 ? `, which brought it ${num(day.news_gain, 2)} €/MWh per hour closer to the realised price (helped).`
          : `, which put it ${num(-day.news_gain, 2)} €/MWh per hour further from the realised price (hurt).`) : "; the realised price is not known yet.");
  }
  $("nimp-note").textContent = txt;
  lineChart($("nimp-chart"), {
    id: "nimp", title: "News effect on the BDT forecast", labels: dates.map((d) => fDay.format(dayDate(d))), height: 200, decimals: 2,
    xTicks: dates.map((d, i) => ({ i, text: fDay.format(dayDate(d)) })).filter((_, i) => i % 7 === 0),
    selected: sel >= 0 ? { i: sel, text: "shown" } : null,
    onPick: (i) => { state.newsDay = dates[i]; renderNews(); renderNewsImpact(); },
    series: [
      { name: "Push on the forecast, €/MWh (day average)", color: "var(--neutral)", values: rows.map((d) => (ok(d.news_push) ? d.news_push : null)) },
      { name: "Error reduction, €/MWh (above 0 = the news helped)", color: "var(--combined)", values: rows.map((d) => (ok(d.news_gain) ? d.news_gain : null)) },
    ],
    empty: "Not computed yet for this zone.",
  });
}

/* ---------- market level and drift ---------- */
function renderLevel(animate = true) {
  const d = state.doc, lv = d.level.slice(-state.levelRange);
  $("level-note").textContent = "The market level index is what the market paid in the past two weeks at a fixed amount of demand left after wind and solar " +
    `(zone ${d.level_zone}). When it moves away from its one-year normal without a change in weather or demand, something outside the models ` +
    "(fuel prices, politics, plant outages) is moving prices.";
  const monthly = state.levelRange > 120;
  lineChart($("level-chart"), {
    id: "level", title: "Market level index", labels: lv.map((x) => fDay.format(dayDate(x.date)) + " " + x.date.slice(0, 4)), height: 220, decimals: 0, animate,
    xTicks: lv.map((x, i) => ({ i, text: monthly ? fmt({ month: "short", year: "2-digit" }).format(dayDate(x.date)) : fDay.format(dayDate(x.date)) }))
      .filter((t, i) => (monthly ? lv[i].date.endsWith("-01") : i % 14 === 0)),
    series: [
      { name: "Market level, last 14 days", color: "var(--combined)", values: lv.map((x) => x.level) },
      { name: "Normal (median of the year before)", color: "var(--neutral)", values: lv.map((x) => x.normal) },
    ],
  });
  const st = $("drift-status");
  st.textContent = "";
  if (!d.drift) return;
  const recent = (d.alarms || []).filter((a) => dayDate(a.date) >= dayDate(d.drift.as_of) - 30 * 864e5);
  const dot = el("span", "dot");
  dot.style.background = recent.length ? "var(--warning)" : "var(--good)";
  const text = recent.length
    ? `⚠ Drift alarm: the tree model's forecasts were ${recent[recent.length - 1].direction} for several days in a row (last alarm ${fDay.format(dayDate(recent[recent.length - 1].date))}; ${recent.length} in the 30 days to ${fDay.format(dayDate(d.drift.as_of))}).`
    : `✓ No drift alarm in the 30 days to ${fDay.format(dayDate(d.drift.as_of))}: the tree model's errors have not piled up in one direction.`;
  st.append(dot, el("span", "", text));
}

/* ---------- wiring ---------- */
async function loadZone(code) {
  state.zone = code;
  const doc = await (await fetch(`data/${code}.json`, { cache: "no-cache" })).json();
  if (code !== state.zone) return;
  state.doc = doc;
  state.dayIdx = doc.hourly.length - 1;
  document.querySelectorAll(".ov-row").forEach((r) => r.setAttribute("aria-pressed", String(r.dataset.zone === code)));
  renderForecast(); renderRecord(); renderLevel(); renderWeather(); renderNewsImpact();
  history.replaceState(null, "", "#" + code);
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme").textContent = t === "dark" ? "Light mode" : "Dark mode";
}

async function init() {
  applyTheme(document.documentElement.dataset.theme || "dark");
  $("theme").addEventListener("click", () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", t);
    applyTheme(t);
  });
  [state.zones, state.news] = await Promise.all(["data/zones.json", "data/news.json"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => r.json())));
  const sel = $("zone");
  for (const z of state.zones.zones) {
    const o = el("option", "", `${z.name} (${z.code})`);
    o.value = z.code;
    sel.append(o);
  }
  const wanted = location.hash.slice(1), first = state.zones.zones.some((z) => z.code === wanted) ? wanted : state.zones.zones[0].code;
  sel.value = first;
  sel.addEventListener("change", () => loadZone(sel.value));
  $("day-prev").addEventListener("click", () => { state.dayIdx = Math.max(0, state.dayIdx - 1); renderForecast(); });
  $("day-next").addEventListener("click", () => { state.dayIdx = Math.min(state.doc.hourly.length - 1, state.dayIdx + 1); renderForecast(); });
  segmented("rec-range", state.range, (v) => { state.range = v; renderRecord(); });
  segmented("lvl-range", state.levelRange, (v) => { state.levelRange = v; renderLevel(); });
  const ex = $("exported");
  ex.append(el("i"), document.createTextNode(`Updated ${fDayHour.format(new Date(state.zones.exported_at))}`));
  state.zone = first;
  renderOverview();
  renderNews();
  await loadZone(first);
}

init().catch((e) => {
  document.querySelector("header").append(el("p", "note", "The forecast data could not be loaded. Please try again later."));
  console.error(e);
});
