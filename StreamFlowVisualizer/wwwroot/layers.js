// Parameter layer definitions: each kind owns its sparkline treatment and caption.

const HOUR = 3600000;

const esc = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (value) => new Intl.NumberFormat("en-US", {
  maximumFractionDigits: Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2,
}).format(value);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ramp(stops, t) {
  const scaled = clamp01(t) * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const a = hexToRgb(stops[index]);
  const b = hexToRgb(stops[index + 1]);
  const f = scaled - index;
  return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], f))).join(",")})`;
}

const COLD_TO_HOT = ["#4aa8ff", "#57d8ed", "#a4e1bd", "#ffc568", "#ff6b57"];

function isFahrenheit(unit) {
  return /°?\s*f\b|deg\s*f|fahrenheit/i.test(unit) && !/c\b|celsius/i.test(unit);
}

function toCelsius(value, unit) {
  return isFahrenheit(unit) ? (value - 32) * 5 / 9 : value;
}

// Each kind: domain(stats, unit) -> [lo, hi] used for the sparkline.
const KINDS = {
  discharge: {
    label: "Discharge",
    color: "#57d8ed",
    domain: (s) => [0, s.max],
    band: (s) => [s.p25, s.p75],
    bandLabel: "Typical range (25th–75th pct.)",
    caption: (c) => `${Math.round(c.t * 100)}% of this period's peak flow`,
  },
  temperature: {
    label: "Temperature",
    color: "#ffc568",
    threshold: 16,
    domain: (s, unit) => [Math.min(s.min, isFahrenheit(unit) ? 32 : 0), Math.max(s.max, isFahrenheit(unit) ? 70 : 20)],
    colorAt: (value, unit) => ramp(COLD_TO_HOT, toCelsius(value, unit) / 24),
    thresholdValue: (unit) => (isFahrenheit(unit) ? 60.8 : 16),
    caption: (c) => (!/water/i.test(c.name) ? `Air temperature, ${fmt(toCelsius(c.value, c.unit))} °C`
      : toCelsius(c.value, c.unit) > 16
        ? "Above the 16 °C salmonid stress guideline"
        : "Within the 16 °C salmonid guideline"),
  },
  stage: {
    label: "Stage",
    color: "#6aa7ff",
    step: true,
    domain: (s) => [s.min, s.max],
    caption: (c) => `${Math.round(c.t * 100)}% up the observed stage range`,
  },
  turbidity: {
    label: "Turbidity",
    color: "#b8935f",
    log: true,
    domain: (s) => [0, Math.max(s.max, 1)],
    caption: (c) => (c.t > 0.66 ? "Murky: heavy suspended sediment" : c.t > 0.33 ? "Cloudy water" : "Relatively clear water"),
  },
  oxygen: {
    label: "Dissolved oxygen",
    color: "#7be3c0",
    threshold: 8,
    domain: (s) => [0, Math.max(s.max, 12)],
    thresholdValue: () => 8,
    colorAt: (value) => (value < 8 ? "#ff6b57" : "#7be3c0"),
    caption: (c) => (c.value < 8 ? "Below the 8 mg/L habitat guideline" : "At or above the 8 mg/L guideline"),
  },
  ph: {
    label: "pH",
    color: "#c79bff",
    bandRange: [6.5, 8.5],
    fixedDomain: [4, 10],
    caption: (c) => (c.value < 6.5 ? "Acidic: below the 6.5–8.5 range" : c.value > 8.5 ? "Basic: above the 6.5–8.5 range" : "Within the 6.5–8.5 range"),
  },
  conductivity: {
    label: "Conductivity",
    color: "#f08ad0",
    domain: (s) => [s.min, s.max],
    caption: (c) => `${Math.round(c.t * 100)}% of this period's ionic range`,
  },
  generic: {
    label: "Parameter",
    color: "#a4e1bd",
    domain: (s) => [s.min, s.max],
    caption: (c) => `${Math.round(c.t * 100)}% of this period's range`,
  },
};

export function kindFor(name) {
  const text = name.toLowerCase();
  if (/discharge|streamflow|flow/.test(text) && !/velocity/.test(text)) return "discharge";
  if (/temp/.test(text)) return "temperature";
  if (/gage|gauge|stage|height|level/.test(text)) return "stage";
  if (/turbid/.test(text)) return "turbidity";
  if (/oxygen|\bdo\b/.test(text)) return "oxygen";
  if (/\bph\b/.test(text)) return "ph";
  if (/conductiv|salinity/.test(text)) return "conductivity";
  return "generic";
}

export function kindColor(name) {
  return KINDS[kindFor(name)].color;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

export function buildLayer(parameter, unit, observations) {
  const obs = observations.map((item) => ({ ...item, time: new Date(item.date).getTime() }));
  const sorted = obs.map((item) => item.value).sort((a, b) => a - b);
  const stats = sorted.length
    ? {
      min: sorted[0],
      max: sorted.at(-1),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
    }
    : { min: 0, max: 1, p25: 0, p75: 1 };
  const gaps = obs.slice(1).map((item, i) => item.time - obs[i].time).sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : HOUR;
  return {
    id: parameter.id,
    name: parameter.name,
    unit,
    kind: kindFor(parameter.name),
    obs,
    stats,
    tolerance: Math.max(medianGap * 3, 6 * HOUR),
  };
}

export function sampleAt(layer, time) {
  const { obs } = layer;
  if (!obs.length) return null;
  let lo = 0;
  let hi = obs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  const best = lo > 0 && Math.abs(obs[lo - 1].time - time) < Math.abs(obs[lo].time - time) ? lo - 1 : lo;
  return Math.abs(obs[best].time - time) <= layer.tolerance ? obs[best] : null;
}

function context(layer, sample) {
  const kind = KINDS[layer.kind];
  const [lo, hi] = kind.fixedDomain ?? kind.domain(layer.stats, layer.unit);
  const transform = kind.log ? (v) => Math.log10(Math.max(v, 0) + 1) : (v) => v;
  const range = transform(hi) - transform(lo) || 1;
  const thresholdValue = kind.thresholdValue?.(layer.unit);
  return {
    name: layer.name,
    value: sample.value,
    unit: layer.unit,
    domain: [lo, hi],
    t: clamp01((transform(sample.value) - transform(lo)) / range),
    thresholdT: thresholdValue === undefined ? 0 : clamp01((transform(thresholdValue) - transform(lo)) / range),
  };
}

function safeId(layer) {
  return String(layer.id).replace(/[^a-z0-9]/gi, "");
}

function sparkline(layer, time) {
  const kind = KINDS[layer.kind];
  const W = 240;
  const H = 48;
  const P = 3;
  const obs = layer.obs;
  const [lo, hi] = kind.fixedDomain ?? kind.domain(layer.stats, layer.unit);
  const thresholdValue = kind.thresholdValue?.(layer.unit);
  const domainLo = Math.min(lo, thresholdValue ?? lo);
  const domainHi = Math.max(hi, thresholdValue ?? hi);
  const transform = kind.log ? (v) => Math.log10(Math.max(v, 0) + 1) : (v) => v;
  const range = transform(domainHi) - transform(domainLo) || 1;
  const y = (v) => H - P - clamp01((transform(v) - transform(domainLo)) / range) * (H - 2 * P);
  const t0 = obs[0].time;
  const span = obs.at(-1).time - t0 || 1;
  const x = (t) => P + ((t - t0) / span) * (W - 2 * P);

  const stride = Math.max(1, Math.ceil(obs.length / 140));
  const points = obs.filter((_, i) => i % stride === 0 || i === obs.length - 1);
  let path = "";
  points.forEach((item, i) => {
    const px = x(item.time).toFixed(1);
    const py = y(item.value).toFixed(1);
    if (i === 0) path = `M${px} ${py}`;
    else if (kind.step) path += ` H${px} V${py}`;
    else path += ` L${px} ${py}`;
  });
  const area = kind.band || kind.step
    ? ""
    : `<path d="${path} L${x(obs.at(-1).time).toFixed(1)} ${H} L${P} ${H} Z" fill="url(#fill-${safeId(layer)})" />`;

  const id = safeId(layer);
  let defs = `<linearGradient id="fill-${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${kind.color}" stop-opacity="0.3"/><stop offset="1" stop-color="${kind.color}" stop-opacity="0"/></linearGradient>`;
  let stroke = kind.color;
  if (kind.colorAt) {
    const stops = [0, 1, 2, 3, 4].map((i) => {
      const value = domainHi - ((domainHi - domainLo) * i) / 4;
      return `<stop offset="${i / 4}" stop-color="${kind.colorAt(value, layer.unit)}"/>`;
    }).join("");
    defs += `<linearGradient id="stroke-${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${P}" y2="${H - P}">${stops}</linearGradient>`;
    stroke = `url(#stroke-${id})`;
  }

  let decoration = "";
  if (kind.band) {
    const [b0, b1] = kind.band(layer.stats);
    decoration += `<rect x="${P}" y="${y(b1).toFixed(1)}" width="${W - 2 * P}" height="${Math.max(1, y(b0) - y(b1)).toFixed(1)}" fill="${kind.color}" opacity="0.16"/>`;
  }
  if (kind.bandRange) {
    const [b0, b1] = kind.bandRange;
    decoration += `<rect x="${P}" y="${y(b1).toFixed(1)}" width="${W - 2 * P}" height="${(y(b0) - y(b1)).toFixed(1)}" fill="${kind.color}" opacity="0.14"/>`;
  }
  if (thresholdValue !== undefined) {
    decoration += `<line x1="${P}" x2="${W - P}" y1="${y(thresholdValue).toFixed(1)}" y2="${y(thresholdValue).toFixed(1)}" stroke="#ff6b57" stroke-width="1" stroke-dasharray="3 3" opacity="0.8"/>`;
  }
  if (kind.log) {
    decoration += `<text x="${W - P}" y="9" text-anchor="end" class="spark-note">LOG SCALE</text>`;
  }

  const sample = sampleAt(layer, time);
  const cursor = sample
    ? `<line x1="${x(sample.time).toFixed(1)}" x2="${x(sample.time).toFixed(1)}" y1="0" y2="${H}" stroke="#e7ece8" stroke-opacity="0.45"/>
       <circle cx="${x(sample.time).toFixed(1)}" cy="${y(sample.value).toFixed(1)}" r="3" fill="${kind.colorAt ? kind.colorAt(sample.value, layer.unit) : kind.color}" stroke="#fff" stroke-width="1.2"/>`
    : "";
  return `<svg class="layer-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(layer.name)} history"><defs>${defs}</defs>${decoration}${area}<path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${cursor}</svg>`;
}

export function renderPendingGroup(count) {
  return `<article class="layer-card layer-empty-group"><p class="layer-caption">Loading ${count} more parameter${count === 1 ? "" : "s"}…</p></article>`;
}

export function renderEmptyGroup(names, failed = []) {
  if (!names.length && !failed.length) return "";
  const list = (items) => items.map((name) => `<li>${esc(name)}</li>`).join("");
  const group = (key, label, items) => items.length
    ? `<details class="layer-card layer-empty-group" data-card-key="${key}" open>
        <summary><span class="layer-name">${label}</span></summary>
        <div class="layer-card-body"><div class="layer-card-content"><ul>${list(items)}</ul></div></div>
      </details>`
    : "";
  return group("status:empty", "No observations for this period", names) +
    group("status:failed", "Could not load", failed);
}

export function renderCard(layer, time, { focused = false } = {}) {
  const kind = KINDS[layer.kind];
  if (!layer.obs.length) {
    return `<details class="layer-card" data-card-key="parameter:${esc(layer.id)}" data-kind="${layer.kind}" style="--layer-color:${kind.color}" open>
      <summary><span class="layer-name">${esc(layer.name)}</span></summary>
      <div class="layer-card-body"><div class="layer-card-content"><p class="layer-caption">No observations for this period.</p></div></div></details>`;
  }
  const sample = sampleAt(layer, time);
  const caption = sample ? kind.caption(context(layer, sample)) : "No reading near the selected time";
  const legend = kind.bandLabel ? `<span class="layer-legend">${esc(kind.bandLabel)}</span>` : "";
  return `<details class="layer-card${focused ? " is-focused" : ""}" data-card-key="parameter:${esc(layer.id)}" data-kind="${layer.kind}" style="--layer-color:${kind.color}" open>
    <summary><span class="layer-name">${esc(layer.name)}</span>
    <span class="layer-value"><strong>${sample ? esc(fmt(sample.value)) : "—"}</strong> ${esc(layer.unit)}</span></summary>
    <div class="layer-card-body"><div class="layer-card-content">
    ${sparkline(layer, time)}
    <p class="layer-caption">${esc(caption)}</p>${legend}</div>
    <div class="chart-resize-handle" data-chart-resize="parameter" role="separator" tabindex="0" aria-label="Resize ${esc(layer.name)} chart" aria-orientation="horizontal" aria-valuemin="40" aria-valuemax="300" aria-valuenow="48"></div>
    </div></details>`;
}
