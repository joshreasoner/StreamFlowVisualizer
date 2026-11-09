import { sampleAt } from "./layers.js";

const METERS_PER_DEGREE = 111320;
const COLD = [59, 130, 246];
const MILD = [45, 212, 191];
const WARM = [245, 158, 11];
const HOT = [239, 68, 68];
const MURK = [138, 107, 63];
const DEFAULT_COLOR = [69, 217, 161];

const mix = (from, to, t) => from.map((value, index) => value + (to[index] - value) * t);
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const rgb = (color) => `rgb(${color.map(Math.round).join(",")})`;

function temperatureColor(value, unit) {
  const celsius = /f/i.test(unit) ? (value - 32) * 5 / 9 : value;
  const t = clamp01((celsius - 4) / 20);
  if (t < 0.4) return mix(COLD, MILD, t / 0.4);
  if (t < 0.7) return mix(MILD, WARM, (t - 0.4) / 0.3);
  return mix(WARM, HOT, (t - 0.7) / 0.3);
}

function layerOf(enabled, layers, kind, namePattern) {
  for (const id of enabled) {
    const layer = layers.get(id);
    if (layer?.kind === kind && layer.obs.length && (!namePattern || namePattern.test(layer.name))) {
      return layer;
    }
  }
  return null;
}

// Share of the period's rain that fell in the 3 hours before `time`, scaled so light rain still shows.
export function rainRate(enabled, layers, time) {
  const rain = layerOf(enabled, layers, "generic", /rain|precip/i);
  if (!rain) return 0;
  let recent = 0;
  for (const item of rain.obs) {
    if (item.time <= time && item.time > time - 3 * 3600000) recent += Math.max(item.value, 0);
  }
  return recent > 0 ? Math.max(0.25, clamp01(recent / 0.05)) : 0;
}

// Drops fall from above the rain column's top; `phase` is a 0..1 looping clock.
export function buildRainDrops(position, metersPerPixel, rate, phase) {
  const features = [];
  if (!position || rate <= 0) return { type: "FeatureCollection", features };
  const [lon, lat] = position;
  const metersPerLon = METERS_PER_DEGREE * Math.cos(lat * Math.PI / 180);
  const count = Math.round(6 + 14 * rate);
  for (let index = 0; index < count; index += 1) {
    const seed = (index * 0.618034) % 1;
    const dropPhase = (phase * (1 + seed * 0.6) + seed) % 1;
    const xOffset = 14 + (seed - 0.5) * 26;
    const yOffset = (((index * 0.37) % 1) - 0.5) * 26;
    const baseHeight = 90 * (1 - dropPhase);
    const cx = lon + (xOffset * metersPerPixel) / metersPerLon;
    const cy = lat + (yOffset * metersPerPixel) / METERS_PER_DEGREE;
    const half = (1.2 * metersPerPixel) / metersPerLon;
    const halfLat = (1.2 * metersPerPixel) / METERS_PER_DEGREE;
    features.push({
      type: "Feature",
      properties: { base: baseHeight * metersPerPixel, height: (baseHeight + 7) * metersPerPixel },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [cx - half, cy - halfLat], [cx + half, cy - halfLat],
          [cx + half, cy + halfLat], [cx - half, cy + halfLat],
          [cx - half, cy - halfLat],
        ]],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

// Two screen-sized columns beside the station: gage height (level) and cumulative rainfall.
export function buildStationColumns(enabled, layers, time, metersPerPixel, position) {
  const features = [];
  if (!position) return { type: "FeatureCollection", features };
  const [lon, lat] = position;
  const metersPerLon = METERS_PER_DEGREE * Math.cos(lat * Math.PI / 180);
  const column = (offsetPx, height, color) => {
    const cx = lon + (offsetPx * metersPerPixel) / metersPerLon;
    const half = (5 * metersPerPixel) / metersPerLon;
    const halfLat = (5 * metersPerPixel) / METERS_PER_DEGREE;
    features.push({
      type: "Feature",
      properties: { height: height * metersPerPixel, color },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [cx - half, lat - halfLat], [cx + half, lat - halfLat],
          [cx + half, lat + halfLat], [cx - half, lat + halfLat],
          [cx - half, lat - halfLat],
        ]],
      },
    });
  };

  const stage = layerOf(enabled, layers, "stage");
  const stageSample = stage && sampleAt(stage, time);
  if (stageSample) {
    const span = stage.stats.max - stage.stats.min || 1;
    column(-14, 6 + 54 * clamp01((stageSample.value - stage.stats.min) / span), "#38bdf8");
  }

  const rain = layerOf(enabled, layers, "generic", /rain|precip/i);
  if (rain) {
    let total = 0;
    let cumulative = 0;
    for (const item of rain.obs) {
      total += Math.max(item.value, 0);
      if (item.time <= time) cumulative += Math.max(item.value, 0);
    }
    if (total > 0) column(14, 4 + 56 * Math.sqrt(cumulative / total), "#a5f3fc");
  }
  return { type: "FeatureCollection", features };
}

// Width encodes the period mean, height the current flow, color water temperature, haze turbidity.
export function describeWaterWall(enabled, layers, time, metersPerPixel = 1) {
  const discharge = layerOf(enabled, layers, "discharge");
  if (!discharge) return null;
  const sample = sampleAt(discharge, time);
  if (!sample) return null;

  const mean = discharge.obs.reduce((sum, item) => sum + item.value, 0) / discharge.obs.length;
  const peak = Math.max(discharge.stats.max, 1);
  let color = DEFAULT_COLOR;
  let opacity = 0.85;

  const temperature = layerOf(enabled, layers, "temperature", /water/i);
  const temperatureSample = temperature && sampleAt(temperature, time);
  if (temperatureSample) color = temperatureColor(temperatureSample.value, temperature.unit);

  const turbidity = layerOf(enabled, layers, "turbidity");
  const turbiditySample = turbidity && sampleAt(turbidity, time);
  if (turbiditySample) {
    const haze = clamp01(Math.log10(Math.max(turbiditySample.value, 0) + 1) / 2);
    color = mix(color, MURK, haze * 0.85);
    opacity = 0.85 - haze * 0.3;
  }

  return {
    height: (6 + 44 * Math.sqrt(clamp01(Math.max(sample.value, 0) / peak))) * metersPerPixel,
    width: Math.min(5 + 1.1 * Math.sqrt(Math.max(mean, 0)), 18) * metersPerPixel,
    color: rgb(color),
    opacity,
  };
}

// Builds one extruded quad per path segment, offset to both sides of the centerline.
export function buildWaterWallFeatures(paths, wall) {
  const features = [];
  for (const path of paths) {
    const { coordinates } = path;
    for (let index = 1; index < coordinates.length; index += 1) {
      const [x1, y1] = coordinates[index - 1];
      const [x2, y2] = coordinates[index];
      const metersPerLon = METERS_PER_DEGREE * Math.cos(((y1 + y2) / 2) * Math.PI / 180);
      const dx = (x2 - x1) * metersPerLon;
      const dy = (y2 - y1) * METERS_PER_DEGREE;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const half = wall.width / 2;
      const offsetLon = (-dy / length * half) / metersPerLon;
      const offsetLat = (dx / length * half) / METERS_PER_DEGREE;
      features.push({
        type: "Feature",
        properties: { height: wall.height, color: wall.color, opacity: wall.opacity },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [x1 + offsetLon, y1 + offsetLat],
            [x2 + offsetLon, y2 + offsetLat],
            [x2 - offsetLon, y2 - offsetLat],
            [x1 - offsetLon, y1 - offsetLat],
            [x1 + offsetLon, y1 + offsetLat],
          ]],
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}
