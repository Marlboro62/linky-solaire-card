/*
 * Carte Linky Solaire — énergie produite, importée et exportée, jour par jour, pour Home Assistant.
 * Même style que la Carte Enedis Linky New (content-card-linky-new), mais indépendante :
 * elle s'installe comme une ressource à part et ne remplace aucune autre carte.
 *
 * Les valeurs par jour viennent des statistiques longue durée de Home Assistant
 * (les mêmes que le tableau de bord Énergie) : n'importe quel compteur d'énergie convient.
 *
 *   type: custom:linky-solaire-card
 *   production: sensor.<production_solaire>
 *   import: sensor.<energie_importee>
 *   export: sensor.<energie_exportee>
 *   days: 7
 */

(() => {
const CARD_VERSION = "0.3.0";

/* ------------------------------------------------------------- affichage */

const fmt = (n, digits = 1) =>
  n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Classe de thème de la carte :
 *  v2   : style MyElectricalData, toujours bleu nuit ;
 *  auto : style MyElectricalData, bleu nuit si Home Assistant est en mode sombre, clair sinon ;
 *  ha   : couleurs du thème Home Assistant (clair ou sombre). */
const themeClass = (theme, hass) => {
  const light = hass?.themes?.darkMode === false;
  if (theme === "ha") return `th-ha${light ? " light" : ""}`;
  if (theme === "auto") return `th-v2${light ? " light" : ""}`;
  return "th-v2";
};

/* ------------------------------------------------------------ carte solaire */

const SOL_DEFAULTS = {
  title: "Solaire",
  days: 7,
  production: "",
  import: "",
  export: "",
  used: "",
  show_used: true,
  show_table: true,
  theme: "v2",
};

/** Les séries, dans l'ordre d'affichage. « Utilisé » (énergie produite consommée sur place) vient de son
 *  capteur, sinon il est calculé chaque jour : produit − exporté. */
const SERIES = [
  { key: "production", label: "Produit", cls: "s-prod", icon: "mdi:solar-power-variant" },
  { key: "used", label: "Utilisé", cls: "s-use", icon: "mdi:home-lightning-bolt-outline" },
  { key: "import", label: "Importé", cls: "s-imp", icon: "mdi:transmission-tower-import" },
  { key: "export", label: "Exporté", cls: "s-exp", icon: "mdi:transmission-tower-export" },
];

const REFRESH_MS = 5 * 60 * 1000; // relecture des statistiques toutes les 5 minutes
const MIN_GAP_MS = 60 * 1000; // au plus une relecture par minute quand un capteur change

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** kWh avec une précision adaptée : 2 décimales sous 1 kWh, 1 au-dessus. */
const kwh = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : fmt(v, Math.abs(v) < 1 ? 2 : 1));

/** Devine les capteurs d'énergie (device_class energy) d'après leur identifiant ou leur nom. */
const guessEntities = (states) => {
  const energy = Object.values(states || {}).filter(
    (s) => s.entity_id?.startsWith("sensor.") && s.attributes?.device_class === "energy" && s.attributes?.state_class,
  );
  const text = (s) => `${s.entity_id} ${s.attributes?.friendly_name || ""}`.toLowerCase();
  const find = (re, not) => energy.find((s) => re.test(text(s)) && !(not && not.test(text(s))))?.entity_id || "";
  const exp = find(/export|inject|revente/);
  const imp = find(/import|soutir/);
  const prod = find(/solai|solar|photovolta|\bpv\b|_pv_|panneau|onduleur|inverter|production/, /export|inject|linky/);
  return { production: prod, import: imp, export: exp };
};

class LinkySolaireCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("linky-solaire-card-editor");
  }

  static getStubConfig(hass) {
    return guessEntities(hass?.states);
  }

  setConfig(config) {
    const days = Math.round(Number(config?.days || SOL_DEFAULTS.days));
    this._config = { ...SOL_DEFAULTS, ...(config || {}), days: Math.min(31, Math.max(1, Number.isFinite(days) ? days : 7)) };
    this._data = null;
    this._error = null;
    this._fetchedAt = 0;
    this._sig = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._clicks) this.shadowRoot.addEventListener("click", (this._clicks = (ev) => {
      const el = ev.target.closest?.("[data-entity]");
      if (!el) return;
      const e = new Event("hass-more-info", { bubbles: true, composed: true });
      e.detail = { entityId: el.dataset.entity };
      this.dispatchEvent(e);
    }));
    this._load();
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    const sig = this._ids().map((id) => hass.states?.[id]?.last_updated || "-").join("|");
    const changed = sig !== this._stateSig;
    this._stateSig = sig;
    if (first || (changed && Date.now() - this._fetchedAt > MIN_GAP_MS)) this._load();
    this._render();
  }

  connectedCallback() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this._load(), REFRESH_MS);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  getCardSize() {
    return 7;
  }

  _ids() {
    return SERIES.map((s) => this._config?.[s.key]).filter(Boolean);
  }

  /** Lit les statistiques longue durée (variation par jour) des capteurs configurés. */
  async _load() {
    const hass = this._hass;
    const c = this._config;
    const ids = this._ids();
    if (!hass || !c || !ids.length || this._loading || typeof hass.callWS !== "function") return;
    this._loading = true;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (c.days - 1));
    try {
      const res = await hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        end_time: new Date().toISOString(),
        statistic_ids: ids,
        period: "day",
        types: ["change"],
        units: { energy: "kWh" },
      });
      this._data = { start, res: res || {} };
      this._error = null;
    } catch (err) {
      this._error = err?.message || String(err);
    } finally {
      this._loading = false;
      this._fetchedAt = Date.now();
      this._sig = null;
      this._render();
    }
  }

  /** « Utilisé » calculé (produit − exporté) : sans capteur dédié, si la production et l'export sont configurés. */
  _usedComputed() {
    const c = this._config;
    return !c.used && c.show_used !== false && !!c.production && !!c.export;
  }

  /** Construit la liste des jours (du plus ancien au plus récent) avec les valeurs de chaque série. */
  _days() {
    const c = this._config;
    const out = [];
    const d = new Date(this._data.start);
    for (let i = 0; i < c.days; i++) {
      out.push({ date: new Date(d), key: dayKey(d) });
      d.setDate(d.getDate() + 1);
    }
    const byKey = new Map(out.map((x) => [x.key, x]));
    for (const s of SERIES) {
      const id = c[s.key];
      if (!id) continue;
      for (const row of this._data.res[id] || []) {
        const t = typeof row.start === "number" ? new Date(row.start) : new Date(row.start);
        const day = byKey.get(dayKey(t));
        if (day && Number.isFinite(row.change)) day[s.key] = (day[s.key] || 0) + row.change;
      }
    }
    if (this._usedComputed()) {
      for (const d of out) if (d.production !== undefined && d.export !== undefined) d.used = Math.max(0, d.production - d.export);
    }
    return out;
  }

  _render() {
    if (!this._config || !this.shadowRoot) return;
    const c = this._config;
    const hass = this._hass;
    const sig = `${c.theme}|${hass?.themes?.darkMode}|${this._fetchedAt}|${this._error}|${!!hass}`;
    if (sig === this._sig) return;
    this._sig = sig;

    const ids = this._ids();
    const header = `<header>
        <div class="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true"><path class="house" d="M4 14.5 16 4l12 10.5V27a1.5 1.5 0 0 1-1.5 1.5h-5M10.5 28.5h-5A1.5 1.5 0 0 1 4 27V14.5"/><circle class="sun" cx="16" cy="18" r="4.2"/></svg>
          <div><div class="title">${esc(c.title)}</div><div class="sub">${c.days === 1 ? "Aujourd'hui" : `${c.days} derniers jours, aujourd'hui compris`}</div></div>
        </div>
      </header>`;
    const card = (body) => {
      this.shadowRoot.innerHTML = `${STYLE}${SOL_STYLE}<ha-card class="${themeClass(c.theme, hass)}">${header}${body}</ha-card>`;
    };

    if (!ids.length) {
      card(`<div class="empty">Aucun capteur configuré<span>Choisissez au moins un capteur d'énergie (produit, importé ou exporté) dans l'éditeur de la carte.</span></div>`);
      return;
    }
    if (this._error && !this._data) {
      card(`<div class="empty">Impossible de lire les statistiques<span>${esc(this._error)}</span></div>`);
      return;
    }
    if (!this._data) {
      card(`<div class="empty"><span>Chargement des statistiques…</span></div>`);
      return;
    }

    const days = this._days();
    const computed = this._usedComputed();
    const active = SERIES.filter((s) => (s.key === "used" ? (c.used && c.show_used !== false) || computed : c[s.key]));
    const noStats = active.filter((s) => c[s.key] && !(this._data.res[c[s.key]] || []).length);
    const total = (k) => {
      const v = days.map((d) => d[k]).filter((x) => x !== undefined);
      return v.length ? v.reduce((a, b) => a + b, 0) : null;
    };
    const T = Object.fromEntries(active.map((s) => [s.key, total(s.key)]));

    // Autoconsommation = capteur « utilisé », sinon produit − exporté ; autonomie = autoconsommé / (autoconsommé + importé)
    const self = c.used && T.used != null ? T.used : T.production != null && T.export != null ? Math.max(0, T.production - T.export) : null;
    const selfPct = self != null && T.production > 0 ? (self / T.production) * 100 : null;
    const auto = self != null && T.import != null && self + T.import > 0 ? (self / (self + T.import)) * 100 : null;

    const tiles = active
      .map((s) => `<div class="tile ${s.cls}" data-entity="${esc(c[s.key] || c.production)}"${s.key === "used" && !c.used ? ' title="Calculé : produit − exporté"' : ""}>
          <div class="tile-l"><i class="sw"></i>${s.label}</div>
          <div class="tile-v">${kwh(T[s.key])}<span>kWh</span></div>
          <div class="tile-n">${this._todayLine(days, s.key)}</div>
        </div>`)
      .join("");
    const ratios = self != null
      ? `<div class="ratios">
          <div><span class="r-l">Autoconsommé</span><b>${kwh(self)} kWh</b>${selfPct != null ? `<small>${fmt(selfPct, 0)} % de la production</small>` : ""}</div>
          ${auto != null ? `<div><span class="r-l">Autonomie</span><b>${fmt(auto, 0)} %</b><small>des besoins couverts par le solaire</small></div>` : ""}
        </div>`
      : "";

    const legend = active.map((s) => `<span><i class="${s.cls}"></i>${s.label}</span>`).join("");
    const chart = `<div class="chart sol">
        <div class="chart-h"><span>Par jour, en kWh</span><span class="sol-leg">${legend}</span></div>
        ${this._chart(days, active)}
      </div>`;

    const table = c.show_table !== false
      ? `<table class="sol-t">
          <thead><tr><th></th>${active.map((s) => `<th class="${s.cls}"><i class="sw"></i>${s.label}</th>`).join("")}</tr></thead>
          <tbody>${[...days].reverse().map((d, i) => `<tr${i === 0 ? ' class="today"' : ""}><td>${this._dayLabel(d, i === 0)}</td>${active.map((s) => `<td>${kwh(d[s.key])}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>`
      : "";

    const warn = noStats.length
      ? `<div class="sol-warn">Pas de statistiques pour ${noStats.map((s) => `<b>${esc(c[s.key])}</b>`).join(", ")}. Le capteur doit être en kWh (ou Wh) avec <code>state_class: total_increasing</code> ou <code>total</code>. Les données apparaissent à la première heure complète.</div>`
      : "";

    card(`<div class="tiles sol-tiles n${active.length}">${tiles}</div>${ratios}${chart}${table}${warn}
      ${this._error ? `<footer>Dernière lecture en erreur : ${esc(this._error)}</footer>` : ""}`);
  }

  _todayLine(days, key) {
    const v = days[days.length - 1]?.[key];
    return v === undefined ? "Aujourd'hui : —" : `Aujourd'hui : ${kwh(v)} kWh`;
  }

  _dayLabel(d, today) {
    if (today) return "Aujourd'hui";
    return d.date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }).replace(/\.$/, "");
  }

  /** Barres groupées par jour (SVG), une barre par série. */
  _chart(days, active) {
    const n = days.length;
    const H = 110;
    const slot = 30;
    const gap = 6;
    const bw = (slot - gap) / active.length;
    const max = Math.max(...days.flatMap((d) => active.map((s) => d[s.key] || 0)), 0.001);
    const bars = days
      .map((d, i) =>
        active
          .map((s, j) => {
            const v = d[s.key];
            if (v === undefined) return "";
            const h = Math.max(v > 0 ? 1.5 : 0, (v / max) * (H - 4));
            const x = i * slot + gap / 2 + j * bw;
            return `<rect class="${s.cls}" x="${x.toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(bw - 0.8).toFixed(2)}" height="${h.toFixed(2)}" rx="1.2"><title>${this._dayLabel(d, i === n - 1)} · ${s.label} : ${kwh(v)} kWh</title></rect>`;
          })
          .join(""),
      )
      .join("");
    const labels = days
      .map((d, i) => {
        const today = i === n - 1;
        const wd = today ? "auj." : d.date.toLocaleDateString("fr-FR", { weekday: "short" }).replace(/\.$/, "");
        return `<div class="day${today ? " on" : ""}">${n <= 14 || i % 2 === 0 ? `${wd}<b>${d.date.getDate()}</b>` : ""}</div>`;
      })
      .join("");
    return `<svg viewBox="0 0 ${n * slot} ${H}" preserveAspectRatio="none" role="img" aria-label="Énergie par jour"><line class="base" x1="0" y1="${H - 0.5}" x2="${n * slot}" y2="${H - 0.5}"/>${bars}</svg>
      <div class="days" style="grid-template-columns:repeat(${n},1fr)">${labels}</div>`;
  }
}

const SOL_STYLE = `<style>
ha-card { display: block; --sol-prod: #f5b82e; --sol-imp: var(--med-blue); --sol-exp: var(--med-green); --sol-use: #b07cf0; }
ha-card.light { --sol-prod: #d18a00; --sol-use: #8a4fd6; }
.brand .sun { fill: var(--sol-prod); }
.sol-tiles.n1 { grid-template-columns: 1fr; }
.sol-tiles.n2 { grid-template-columns: repeat(2, 1fr); }
.sol-tiles.n3 { grid-template-columns: repeat(3, 1fr); }
.sol-tiles.n4 { grid-template-columns: repeat(4, 1fr); }
@container (max-width: 520px) { .sol-tiles.n4 { grid-template-columns: repeat(2, 1fr); } }
@container (max-width: 400px) { .sol-tiles.n3 { grid-template-columns: 1fr; } }
.sol-tiles .tile { cursor: pointer; }
.sol-tiles .tile:hover { background: var(--med-surface); }
.tile-l { display: flex; align-items: center; gap: 6px; }
.sw { width: 9px; height: 9px; border-radius: 3px; display: inline-block; flex: none; }
.s-prod .sw, .sol-leg i.s-prod { background: var(--sol-prod); }
.s-imp .sw, .sol-leg i.s-imp { background: var(--sol-imp); }
.s-exp .sw, .sol-leg i.s-exp { background: var(--sol-exp); }
.s-use .sw, .sol-leg i.s-use { background: var(--sol-use); }
.ratios { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 12px 0; }
.ratios > div { flex: 1 1 150px; padding: 10px 12px; border-radius: 12px; background: var(--med-surface); border: 1px solid var(--med-line);
  display: flex; flex-direction: column; gap: 1px; font-size: .78rem; }
.ratios b { font-size: 1.1rem; }
.ratios .r-l, .ratios small { color: var(--med-muted); }
.sol-leg { display: flex; gap: 10px; }
.sol-leg span { display: inline-flex; align-items: center; gap: 5px; }
.sol-leg i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
.chart.sol svg { height: 140px; }
.chart.sol rect.s-prod { fill: var(--sol-prod); }
.chart.sol rect.s-imp { fill: var(--sol-imp); }
.chart.sol rect.s-exp { fill: var(--sol-exp); }
.chart.sol rect.s-use { fill: var(--sol-use); }
.chart.sol line.base { stroke: var(--med-line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.chart.sol .day { cursor: default; }
.sol-t { width: calc(100% - 24px); margin: 12px 12px 0; border-collapse: collapse; font-size: .8rem; color: var(--med-text); }
.sol-t th { font-weight: 500; color: var(--med-muted); text-align: right; padding: 4px 6px; white-space: nowrap; }
.sol-t th .sw { margin-right: 5px; vertical-align: 0; }
.sol-t th:first-child, .sol-t td:first-child { text-align: left; }
.sol-t td { color: var(--med-text); text-align: right; padding: 5px 6px; border-top: 1px solid var(--med-line); }
.sol-t td:first-child { color: var(--med-muted); text-transform: capitalize; white-space: nowrap; }
.sol-t tr.today td { font-weight: 700; }
.sol-t tr.today td:first-child { color: var(--med-text); }
.sol-warn { margin: 10px 12px 0; padding: 8px 12px; border-radius: 12px; border: 1px solid #f0a33a; font-size: .78rem; line-height: 1.4; }
.sol-warn code { font-size: .74rem; }
ha-card > :last-child:not(footer) { margin-bottom: 14px; }
</style>`;

/* ------------------------------------------------------------------ style */

const STYLE = `<style>
:host {
  --med-bg: #1a2434; --med-surface: #212d40; --med-line: #2f3d55;
  --med-text: #e7edf5; --med-muted: #8fa0b8;
  --med-green: #96d21f; --med-blue: #1d93e3;
  --med-hc: #4a7bd8; --med-hp: #d27333;
  --t-blue: #3f7ff0; --t-white: #e9eef4; --t-red: #ee4a4a;
  --med-up: #f08a4b; --med-down: #5fcf8a;
}
ha-card { background: var(--med-bg); color: var(--med-text); border: 1px solid var(--med-line);
  border-radius: 18px; overflow: hidden; font-variant-numeric: tabular-nums; container-type: inline-size; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 8px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand svg { width: 34px; height: 34px; fill: none; }
.brand .house { stroke: var(--med-green); stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
.brand .bolt { fill: var(--med-accent, var(--med-blue)); }
.title { font-size: 1.15rem; font-weight: 700; letter-spacing: .2px; }
.sub { font-size: .78rem; color: var(--med-muted); }
.tempo { display: flex; gap: 8px; }
.pill { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px;
  background: var(--med-surface); border: 1px solid var(--med-line); font-size: .78rem; }
.pill-l { color: var(--med-muted); }
.pill-v { font-weight: 600; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--med-muted); flex: none; }
.t-blue .dot { background: var(--t-blue); } .t-white .dot { background: var(--t-white); } .t-red .dot { background: var(--t-red); }
.t-none .pill-v { color: var(--med-muted); font-weight: 400; }
.quotas { display: flex; align-items: center; gap: 14px; padding: 0 18px 10px; font-size: .82rem; }
.quota { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.quota small { color: var(--med-muted); font-weight: 400; }
.quota-l { color: var(--med-muted); }

.hero { margin: 4px 12px 0; padding: 16px; border-radius: 14px; background: var(--med-surface);
  border: 1px solid var(--med-line); display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; }
.hero-l { color: var(--med-muted); font-size: .85rem; }
.hero-v { font-size: 2.4rem; font-weight: 700; line-height: 1.1; }
.hero-v span, .tile-v span { font-size: .9rem; font-weight: 500; color: var(--med-muted); margin-left: 4px; }
.hero-r { text-align: right; align-self: center; }
.cost { font-size: 1.6rem; font-weight: 700; color: var(--med-green); }
.cost.none { color: var(--med-muted); }
.cost.est { color: var(--med-text); opacity: .85; }
.hero-p { font-size: .75rem; color: var(--med-muted); margin-top: 6px; }
.cost-l { font-size: .75rem; color: var(--med-muted); max-width: 160px; }
.evo { font-size: .8rem; font-weight: 600; margin-top: 2px; }
.evo.up { color: var(--med-up); } .evo.down { color: var(--med-down); }
.split { grid-column: 1 / -1; margin-top: 6px; }
.split.wait { font-size: .8rem; color: var(--med-muted); border-top: 1px dashed var(--med-line); padding-top: 8px; }
.bar { display: flex; height: 8px; border-radius: 6px; overflow: hidden; background: var(--med-line); }
.bar i { display: block; } .bar .hc { background: var(--med-hc); } .bar .hp { background: var(--med-hp); }
.split-l { display: flex; justify-content: space-between; font-size: .78rem; margin-top: 6px; }
.k-hc { color: #8fb0f0; } .k-hp { color: #eaa070; }

.tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 10px 12px 0; }
@container (min-width: 620px) { .tiles { grid-template-columns: repeat(4, 1fr); } }
@container (min-width: 620px) { .tiles.six { grid-template-columns: repeat(3, 1fr); } }
.tile { padding: 12px; border-radius: 12px; border: 1px solid var(--med-line); }
.tile-l { font-size: .78rem; color: var(--med-muted); }
.tile-v { font-size: 1.35rem; font-weight: 700; margin-top: 2px; }
.tile-n { font-size: .72rem; color: var(--med-muted); margin-top: 4px; }

.chart { margin: 14px 12px 0; }
.chart-h { display: flex; justify-content: space-between; font-size: .82rem; color: var(--med-muted); margin: 0 4px 6px; }
.legend { display: flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-left: 6px; }
.legend .k-hc { background: var(--med-hc); } .legend .k-hp { background: var(--med-hp); }
.chart svg { width: 100%; height: 130px; display: block; }
.chart rect.hc { fill: var(--med-hc); } .chart rect.hp { fill: var(--med-hp); }
.chart rect.partial { fill: var(--med-muted); opacity: .35; }
.chart g.est { opacity: .45; }
.chart rect.sel { fill: rgba(255,255,255,.06); }
.chart rect.hit { fill: transparent; cursor: pointer; }
.days { display: grid; margin-top: 4px; }
.day { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 4px 0; border-radius: 8px; font-size: .68rem; color: var(--med-muted); text-transform: capitalize; }
.day b { color: var(--med-text); font-size: .78rem; }
.day .dot { width: 6px; height: 6px; margin-top: 2px; }
.day.on { background: var(--med-surface); }
.day:focus-visible { outline: 2px solid var(--med-accent, var(--med-blue)); }

.detail { margin: 8px 12px 0; padding: 10px 12px; border-radius: 12px; background: var(--med-surface); border: 1px solid var(--med-line); }
.detail-h { display: flex; align-items: center; gap: 8px; font-size: .8rem; color: var(--med-muted); }
.tag { padding: 1px 8px; border-radius: 999px; font-size: .72rem; font-weight: 700; color: #0f1724; }
.tag.t-blue { background: var(--t-blue); color: #fff; } .tag.t-white { background: var(--t-white); } .tag.t-red { background: var(--t-red); color: #fff; }
.detail-v { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 4px; font-size: .9rem; }
.sep { width: 1px; height: 12px; background: var(--med-line); }
.detail-p { font-size: .78rem; color: var(--med-muted); margin-top: 4px; }
.warn { color: var(--t-red); font-style: normal; font-weight: 600; }

.power { margin: 10px 12px 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--med-line); }
.power.is-over { border-color: var(--t-red); }
.power-t { display: flex; justify-content: space-between; font-size: .85rem; }
.gauge { height: 6px; border-radius: 6px; background: var(--med-line); margin: 8px 0 6px; overflow: hidden; }
.gauge i { display: block; height: 100%; background: linear-gradient(90deg, var(--med-green), var(--med-accent, var(--med-blue))); }
.is-over .gauge i { background: var(--t-red); }
.power-n { font-size: .75rem; color: var(--med-muted); }

.eco { margin: 10px 12px 0; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--med-line); font-size: .82rem; display: flex; align-items: center; gap: 8px; }
.eco.e-ok .dot { background: var(--med-down); }
.eco.e-warn { border-color: #f0a33a; } .eco.e-warn .dot { background: #f0a33a; }
.eco.e-alert { border-color: var(--t-red); } .eco.e-alert .dot { background: var(--t-red); }
.eco-l { color: var(--med-muted); }
footer { padding: 10px 18px 14px; font-size: .7rem; color: var(--med-muted); }
.empty { padding: 18px; display: flex; flex-direction: column; gap: 6px; font-size: .9rem; }
.empty span { color: var(--med-muted); }
/* Thème Home Assistant : fond, textes et bordures suivent le thème clair ou sombre */
ha-card.th-ha {
  /* accent (icônes, onglets, sélections, contours) : couleur principale du thème ; les bleus porteurs de sens restent bleus */
  --med-accent: var(--primary-color, #1d93e3);
  --med-on-accent: var(--text-primary-color, #fff);
  --med-bg: var(--ha-card-background, var(--card-background-color, #fff));
  --med-surface: color-mix(in srgb, var(--primary-text-color, #000) 5%, transparent);
  --med-line: var(--divider-color, rgba(127, 127, 127, .25));
  --med-text: var(--primary-text-color, #1f2937);
  --med-muted: var(--secondary-text-color, #6b7280);
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
}
ha-card.th-ha.light { --med-green: #4c8a0b; --med-up: #c2560f; --med-down: #1d8a4b; }
/* Style MyElectricalData en version claire (theme: auto quand Home Assistant est en mode clair) */
ha-card.th-v2.light {
  --med-bg: #ffffff; --med-surface: #f2f5f9; --med-line: #dbe2ec;
  --med-text: #1a2434; --med-muted: #5b6b82;
  --med-green: #4c8a0b; --med-blue: #1673b8; --med-up: #c2560f; --med-down: #1d8a4b;
  box-shadow: 0 1px 3px rgba(26, 36, 52, .08);
}
ha-card.light .k-hc { color: #2f5fb8; }
ha-card.light .k-hp { color: #b35619; }
ha-card.light .t-white .dot, ha-card.light .tag.t-white { box-shadow: inset 0 0 0 1px #aab3c0; }
ha-card.light .chart rect.sel { fill: rgba(0, 0, 0, .05); }
ha-card.light .tag.t-white { color: #1f2937; }
@media (max-width: 420px) { .hero-v { font-size: 2rem; } .tempo { width: 100%; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>`;

/* ----------------------------------------------------------------- éditeur */

const THEME_SELECT = {
  name: "theme",
  selector: {
    select: {
      mode: "dropdown",
      options: [
        { value: "v2", label: "Style MyElectricalData (bleu nuit)" },
        { value: "auto", label: "Style MyElectricalData, clair ou sombre selon Home Assistant" },
        { value: "ha", label: "Thème Home Assistant (clair ou sombre)" },
      ],
    },
  },
};

/** Éditeur visuel : formulaire Home Assistant construit à partir du schéma. */
function makeEditor(schema, labels, defaults) {
  const hasDays = schema.some((s) => s.name === "days");
  return class extends HTMLElement {
    setConfig(config) {
      this._config = { ...config };
      this._draw();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._form) this._form.hass = hass;
      else this._draw();
    }

    _draw() {
      if (!this._hass || !this._config) return;
      if (!this._form) {
        this._form = document.createElement("ha-form");
        this._form.computeLabel = (s) => labels[s.name] || s.name;
        this._form.addEventListener("value-changed", (ev) => {
          const v = { ...ev.detail.value };
          if (hasDays && v.days !== undefined) v.days = Number(v.days);
          this._config = v;
          this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: v }, bubbles: true, composed: true }));
        });
        this.appendChild(this._form);
      }
      this._form.hass = this._hass;
      this._form.schema = schema;
      this._form.data = hasDays
        ? { ...defaults, ...this._config, days: String(this._config.days || defaults.days) }
        : { ...defaults, ...this._config };
    }
  };
}

const SOL_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "production", selector: { entity: { domain: "sensor", device_class: "energy" } } },
  { name: "import", selector: { entity: { domain: "sensor", device_class: "energy" } } },
  { name: "export", selector: { entity: { domain: "sensor", device_class: "energy" } } },
  { name: "used", selector: { entity: { domain: "sensor", device_class: "energy" } } },
  { name: "show_used", selector: { boolean: {} } },
  {
    name: "days",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "5", label: "5 jours" },
          { value: "7", label: "7 jours" },
          { value: "14", label: "14 jours" },
        ],
      },
    },
  },
  { name: "show_table", selector: { boolean: {} } },
  THEME_SELECT,
];
const SOL_LABELS = {
  title: "Titre",
  production: "Énergie produite (panneaux, onduleur)",
  import: "Énergie importée du réseau",
  export: "Énergie exportée vers le réseau",
  used: "Énergie produite utilisée sur place (facultatif, sinon calculée : produit − exporté)",
  show_used: "Afficher l'énergie utilisée (autoconsommée) par jour",
  days: "Historique affiché",
  show_table: "Afficher le tableau jour par jour",
  theme: "Couleurs de la carte",
};
const LinkySolaireCardEditor = makeEditor(SOL_SCHEMA, SOL_LABELS, SOL_DEFAULTS);

/* ---------------------------------------------------------- enregistrement */

if (typeof customElements !== "undefined") {
  const define = (name, cls) => { if (!customElements.get(name)) customElements.define(name, cls); };
  define("linky-solaire-card", LinkySolaireCard);
  define("linky-solaire-card-editor", LinkySolaireCardEditor);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "linky-solaire-card")) {
    window.customCards.push({
      type: "linky-solaire-card",
      name: "Carte Linky Solaire",
      description: "Énergie produite, importée et exportée jour par jour, autoconsommation et autonomie.",
      preview: true,
    });
  }
  console.info(`%c LINKY-SOLAIRE-CARD %c ${CARD_VERSION} `, "background:#f5b82e;color:#1a2434;font-weight:700", "background:#1d93e3;color:#fff");
}
})();
