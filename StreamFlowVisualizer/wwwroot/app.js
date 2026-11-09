import * as maplibregl from "https://unpkg.com/maplibre-gl@6.16.0/dist/maplibre-gl.mjs";
import { buildLayer, kindColor, renderCard, renderEmptyGroup, renderPendingGroup } from "./layers.js";
import { buildRainDrops, buildStationColumns, buildWaterWallFeatures, describeWaterWall, rainRate } from "./waterwall.js";
import { setupComparison } from "./comparison.js";

const elements = {
  layerList: document.querySelector("#parameter-layer-list"),
  layerSection: document.querySelector("#layer-section"),
  layerCards: document.querySelector("#layer-cards"),
  layersInput: document.querySelector("#layers-input"),
  status: document.querySelector("#status-label"),
  statusContainer: document.querySelector(".data-status"),
  filterForm: document.querySelector("#dashboard-filter"),
  wriaSelect: document.querySelector("#wria-select"),
  stationSelect: document.querySelector("#station-select"),
  stationName: document.querySelector("#station-name"),
  stationSubtitle: document.querySelector("#station-subtitle"),
  mapKickerStation: document.querySelector("#map-kicker-station"),
  mapScale: document.querySelector("#map-scale"),
  sourceLink: document.querySelector("#source-link"),
  stationStatusLabel: document.querySelector("#station-status-label"),
  recordBadge: document.querySelector(".record-badge"),
  flowValue: document.querySelector("#flow-value"),
  parameterName: document.querySelector("#parameter-name"),
  readingTime: document.querySelector("#reading-time"),
  changeIndicator: document.querySelector("#change-indicator"),
  timeline: document.querySelector("#time-slider"),
  timelineDate: document.querySelector("#timeline-date"),
  timelineCurrent: document.querySelector("#timeline-current"),
  timelineStart: document.querySelector("#timeline-start"),
  timelineEnd: document.querySelector("#timeline-end"),
  timelineFlow: document.querySelector("#timeline-flow"),
  playButton: document.querySelector("#play-button"),
  playIcon: document.querySelector("#play-icon"),
  periodSelect: document.querySelector("#period-select"),
  speedSelect: document.querySelector("#speed-select"),
  chart: document.querySelector("#flow-chart"),
  chartEmptyState: document.querySelector("#chart-empty-state"),
  chartDescription: document.querySelector("#chart-description"),
  chartTitle: document.querySelector("#chart-title"),
  chartRange: document.querySelector("#chart-range"),
  chartStart: document.querySelector("#chart-start"),
  chartEnd: document.querySelector("#chart-end"),
  periodMax: document.querySelector("#period-max"),
  periodMin: document.querySelector("#period-min"),
  periodMaxUnit: document.querySelector("#period-max-unit"),
  periodMinUnit: document.querySelector("#period-min-unit"),
  readingUnit: document.querySelector("#reading-unit"),
  timelineUnit: document.querySelector("#timeline-unit"),
  observationCount: document.querySelector("#observation-count"),
  unit: document.querySelector("#unit-label"),
  stationId: document.querySelector("#station-id"),
  coordinates: document.querySelector("#coordinates"),
  dataInterval: document.querySelector("#data-interval"),
  latestRecord: document.querySelector("#latest-record"),
  dataError: document.querySelector("#data-error"),
  mapLoading: document.querySelector("#map-loading"),
  mapError: document.querySelector("#map-error"),
  mapPopup: document.querySelector("#station-popup"),
  popupLabel: document.querySelector("#popup-label"),
  popupName: document.querySelector("#popup-name"),
  popupValue: document.querySelector("#popup-value"),
  globeToggle: document.querySelector("#globe-toggle"),
  terrainToggle: document.querySelector("#terrain-toggle"),
  streamsToggle: document.querySelector("#streams-toggle"),
  mapFlowValue: document.querySelector("#map-flow-value"),
  mapPlaybackNote: document.querySelector("#map-playback-note"),
};

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const valueFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
});
const fullDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

let observations = [];
let flowObservations = [];
let station = null;
let selectedWria = null;
let unit = "ft^3/s";
let flowUnit = "ft^3/s";
let flowParameterId = "";
let selectedParameter = null;
let stationParameters = [];
let parameterRequestController = null;
let isDischargeSelected = true;
let selectedIndex = 0;
let maximumObservedValue = 1;
let flowChart = null;
let map = null;
let stationPosition = null;
let stationMarker = null;
let stationMarkerElement = null;
let stationPopup = null;
let playTimer = null;
let activeReachName = "";
let activeReachId = null;
let flowParticles = [];
let flowPaths = null;
let flowDistanceMeters = 0;
let flowAnimationFrame = null;
let lastFlowFrameTime = null;
const enabledLayerIds = new Set();
const layerData = new Map();
const failedParameterIds = new Set();
let layerRenderFrame = null;

function currentLayerTime() {
  const current = observations[selectedIndex];
  if (current) return new Date(current.date).getTime();
  let latest = Date.now();
  for (const layer of layerData.values()) {
    if (layer.obs.length) latest = layer.obs.at(-1).time;
  }
  return latest;
}

function scheduleLayerRender() {
  if (layerRenderFrame !== null) return;
  layerRenderFrame = window.requestAnimationFrame(() => {
    layerRenderFrame = null;
    renderSidebarParameters();
    updateWaterWall();
  });
}

function updateWaterWall() {
  const source = map?.getSource("water-wall");
  if (!source) return;
  const paths = flowPaths?.length ? flowPaths : getActiveReachPaths();
  const latitude = stationPosition?.[1] ?? 47;
  const metersPerPixel = 156543 * Math.cos(latitude * Math.PI / 180) / 2 ** map.getZoom();
  const wall = paths.length
    ? describeWaterWall(enabledLayerIds, layerData, currentLayerTime(), metersPerPixel)
    : null;
  if (paths.length && !flowPaths?.length) flowPaths = paths;
  source.setData(wall
    ? buildWaterWallFeatures(paths, wall)
    : { type: "FeatureCollection", features: [] });
  map.getSource("station-columns")?.setData(
    buildStationColumns(enabledLayerIds, layerData, currentLayerTime(), metersPerPixel, stationPosition),
  );
  lastMetersPerPixel = metersPerPixel;
  if (rainFrame === null) rainFrame = window.requestAnimationFrame(animateRain);
}

let rainFrame = null;
let lastMetersPerPixel = 1;

function animateRain(timestamp) {
  rainFrame = null;
  const source = map?.getSource("rain-drops");
  if (!source) return;
  const rate = rainRate(enabledLayerIds, layerData, currentLayerTime());
  source.setData(buildRainDrops(stationPosition, lastMetersPerPixel, rate, (timestamp / 1600) % 1));
  if (rate > 0) rainFrame = window.requestAnimationFrame(animateRain);
}

document.addEventListener("map-layers-change", updateWaterWall);

// The sidebar always lists every station parameter; map layer toggles don't affect it.
function renderSidebarParameters() {
  elements.layerSection.hidden = stationParameters.length === 0;
  if (!stationParameters.length) return;

  const time = currentLayerTime();
  const withData = [];
  const empty = [];
  const failed = [];
  let pending = 0;
  for (const parameter of stationParameters) {
    const layer = layerData.get(parameter.id);
    if (layer?.obs.length) withData.push(layer);
    else if (layer) empty.push(parameter.name);
    else if (failedParameterIds.has(parameter.id)) failed.push(parameter.name);
    else pending += 1;
  }
  const template = document.createElement("template");
  template.innerHTML = withData
    .map((layer) => renderCard(layer, time, { focused: layer.id === selectedParameter?.id }))
    .join("") +
    (pending ? renderPendingGroup(pending) : "") +
    renderEmptyGroup(empty, failed);

  const existing = new Map(
    [...elements.layerCards.querySelectorAll("details[data-card-key]")]
      .map((card) => [card.dataset.cardKey, card]),
  );
  let position = elements.layerCards.firstElementChild;
  for (const next of [...template.content.children]) {
    const card = next.dataset.cardKey && existing.get(next.dataset.cardKey);
    if (card) {
      existing.delete(next.dataset.cardKey);
      card.className = next.className;
      card.style.cssText = next.style.cssText;
      card.querySelector("summary").innerHTML = next.querySelector("summary").innerHTML;
      card.querySelector(".layer-card-content").innerHTML = next.querySelector(".layer-card-content").innerHTML;
    }
    const element = card || next;
    if (element.matches("details[data-card-key]")) applyParameterChartHeight(element);
    if (element === position) position = position.nextElementSibling;
    else elements.layerCards.insertBefore(element, position);
  }
  while (position) {
    const next = position.nextElementSibling;
    position.remove();
    position = next;
  }
}

function syncLayersUrl() {
  const value = [...enabledLayerIds].join(",");
  elements.layersInput.value = value;
  const url = new URL(window.location.href);
  if (value) url.searchParams.set("layers", value);
  else url.searchParams.delete("layers");
  window.history.replaceState(null, "", url);
}

async function ensureLayer(parameter) {
  if (layerData.has(parameter.id)) return;
  if (isFlowParameter(parameter)) {
    layerData.set(parameter.id, buildLayer(parameter, flowUnit, flowObservations));
    return;
  }
  const query = new URLSearchParams({
    stationId: station.id,
    parameterId: parameter.id,
    days: elements.periodSelect.value,
  });
  let data;
  for (let attempt = 0; ; attempt += 1) {
    try {
      data = await fetchJson(`/api/parameter-observations?${query}`);
      break;
    } catch (error) {
      if (attempt >= 1) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
  }
  layerData.set(
    parameter.id,
    buildLayer(parameter, data.unit ?? "", parseObservations(data.observations)),
  );
}

// Map visualizations subscribe to "map-layers-change"; the layer list only records what is enabled.
function setLayerEnabled(parameter, enabled) {
  if (enabled) enabledLayerIds.add(parameter.id);
  else enabledLayerIds.delete(parameter.id);
  syncLayersUrl();
  document.dispatchEvent(new CustomEvent("map-layers-change", {
    detail: { enabled: [...enabledLayerIds], changed: parameter.id },
  }));
}

function renderLayerList() {
  elements.layerList.replaceChildren();
  for (const parameter of stationParameters) {
    const label = document.createElement("label");
    label.className = "parameter-layer-option";
    label.style.setProperty("--layer-color", kindColor(parameter.name));
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabledLayerIds.has(parameter.id);
    input.addEventListener("change", () => setLayerEnabled(parameter, input.checked));
    const swatch = document.createElement("span");
    swatch.className = "parameter-layer-swatch";
    swatch.setAttribute("aria-hidden", "true");
    label.append(input, swatch, document.createTextNode(parameter.name));
    elements.layerList.append(label);
  }
}

function restoreLayersFromUrl() {
  const requested = new Set((new URLSearchParams(window.location.search).get("layers") ?? "")
    .split(",")
    .filter(Boolean));
  for (const parameter of stationParameters) {
    if (requested.has(parameter.id)) enabledLayerIds.add(parameter.id);
  }
  syncLayersUrl();
  renderLayerList();
}

async function loadAllParameterData() {
  const queue = [...stationParameters];
  const worker = async () => {
    for (let parameter = queue.shift(); parameter; parameter = queue.shift()) {
      try {
        await ensureLayer(parameter);
      } catch (error) {
        console.error(`Could not load ${parameter.name} data.`, error);
        failedParameterIds.add(parameter.id);
      }
      scheduleLayerRender();
    }
  };
  renderSidebarParameters();
  await Promise.all([worker(), worker(), worker()]);
}

function formatFlow(value) {
  return valueFormatter.format(value);
}

function formatChartFlow(value) {
  return numberFormatter.format(value);
}

function formatFullDate(value) {
  return fullDateFormatter.format(new Date(value));
}

function setDataStatus(message, state = "") {
  elements.status.textContent = message;
  elements.statusContainer.classList.toggle("is-ready", state === "ready");
  elements.statusContainer.classList.toggle("is-error", state === "error");
}

function setLoadingError(message) {
  elements.dataError.textContent = message;
  elements.dataError.hidden = false;
  setDataStatus("Data unavailable", "error");
}

function formatShortDate(value) {
  return shortDateFormatter.format(new Date(value));
}

function createFlowChart() {
  if (!window.Highcharts) {
    console.error("Could not load Highcharts.");
    elements.chartEmptyState.textContent =
      "The chart library could not be loaded. Check your connection and reload.";
    elements.chartEmptyState.hidden = false;
    return;
  }

  flowChart = window.Highcharts.chart(elements.chart, {
    chart: {
      type: "areaspline",
      backgroundColor: "transparent",
      animation: false,
      spacing: [8, 8, 4, 4],
      plotBackgroundColor: "transparent",
      zooming: { type: "x" },
      style: { fontFamily: '"DM Sans", "Segoe UI", sans-serif' },
    },
    title: { text: null },
    accessibility: {
      enabled: true,
      description: "Interactive history chart. Select an observation to update the timeline.",
    },
    credits: { enabled: false },
    legend: { enabled: false },
    tooltip: {
      shared: false,
      backgroundColor: "#192121",
      borderColor: "#394640",
      borderRadius: 6,
      shadow: false,
      useHTML: false,
      style: { color: "#e7ece8" },
      formatter() {
        return `<b>${formatFullDate(this.x)}</b><br/>${window.Highcharts.numberFormat(this.y, 2)} ${unit}`;
      },
    },
    xAxis: {
      type: "datetime",
      lineColor: "#394640",
      tickColor: "#394640",
      tickLength: 4,
      labels: {
        style: { color: "#82908a", fontSize: "10px" },
        formatter() {
          return formatShortDate(this.value);
        },
      },
      crosshair: { color: "#a4e1bd", dashStyle: "ShortDash", width: 1 },
    },
    yAxis: {
      title: { text: undefined },
      min: 0,
      gridLineColor: "#2b3733",
      gridLineDashStyle: "Dash",
      labels: {
        style: { color: "#82908a", fontSize: "10px" },
        formatter() {
          return formatChartFlow(this.value);
        },
      },
    },
    plotOptions: {
      series: {
        animation: false,
        turboThreshold: 0,
        states: { inactive: { opacity: 1 } },
        point: {
          events: {
            click() {
              stopPlayback(true);
              updateObservation(this.index);
            },
          },
        },
      },
      areaspline: {
        lineWidth: 2,
        color: "#9bd9b2",
        fillColor: {
          linearGradient: [0, 0, 0, 180],
          stops: [
            [0, "rgba(164, 225, 189, 0.2)"],
            [1, "rgba(164, 225, 189, 0.015)"],
          ],
        },
        marker: { enabled: false },
      },
      scatter: {
        enableMouseTracking: false,
        marker: {
          radius: 4,
          symbol: "circle",
          lineWidth: 2,
          lineColor: "#ffffff",
          fillColor: "#a4e1bd",
        },
      },
    },
    series: [
      { type: "areaspline", name: "Observation", data: [] },
      { type: "scatter", name: "Selected observation", data: [] },
    ],
  });
}

function drawChart() {
  if (!observations.length) return;

  const values = observations.map((item) => item.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  maximumObservedValue = maximum;
  if (flowChart) {
    flowChart.yAxis[0].update({ min: isDischargeSelected ? 0 : null }, false);
    flowChart.xAxis[0].update({
      tickInterval: (Number(elements.periodSelect.value) * 24 * 60 * 60 * 1000) / 6,
    }, false);
    flowChart.series[0].setData(
      observations.map((item) => [new Date(item.date).getTime(), item.value]),
      false,
    );
    flowChart.series[1].setData([], false);
    flowChart.redraw(false);
    elements.chartEmptyState.hidden = true;
  }
  const intervalMinutes = observations.length > 1
    ? Math.max(1, Math.round((new Date(observations[1].date) - new Date(observations[0].date)) / 60000))
    : null;
  elements.dataInterval.textContent = intervalMinutes ? `${intervalMinutes} min` : "—";
  elements.periodMax.textContent = formatChartFlow(maximum);
  elements.periodMin.textContent = formatChartFlow(minimum);
  elements.observationCount.textContent = numberFormatter.format(observations.length);
  elements.chartStart.textContent = formatShortDate(observations[0].date);
  elements.chartEnd.textContent = formatShortDate(observations.at(-1).date);
  elements.timelineStart.textContent = formatShortDate(observations[0].date);
  elements.timelineEnd.textContent = formatShortDate(observations.at(-1).date);
  elements.latestRecord.textContent = dateFormatter.format(new Date(observations.at(-1).date));
  elements.unit.textContent = unit.toUpperCase();
  elements.readingUnit.textContent = unit;
  elements.periodMaxUnit.textContent = unit;
  elements.periodMinUnit.textContent = unit;
  elements.timelineUnit.textContent = unit;
  elements.chartRange.textContent = `Last ${elements.periodSelect.value} days`;
  elements.chart.setAttribute("aria-label", `${selectedParameter?.name ?? "Discharge"} history chart`);
  elements.chartTitle.textContent = `${(selectedParameter?.name ?? "Discharge").toUpperCase()} HISTORY`;
  elements.chartDescription.textContent =
    `${selectedParameter?.name ?? "Discharge"} ranges from ${formatFlow(minimum)} to ${formatFlow(maximum)} ${unit} across ${observations.length} observations.`;
  elements.parameterName.textContent = (selectedParameter?.name ?? "Discharge").toUpperCase();
  elements.timeline.disabled = false;
  elements.playButton.disabled = observations.length < 2;
  elements.mapFlowValue.textContent = "— CFS";
  elements.popupLabel.textContent = `${selectedParameter?.name ?? "Discharge"} · ${station?.id ?? ""}`;
  elements.mapPlaybackNote.textContent = isDischargeSelected
    ? "PLAY RIPPLES FOLLOW FLOW · ILLUSTRATIVE"
    : "SELECT DISCHARGE TO ANIMATE FLOW";

  updateObservation(selectedIndex);
}

function drawEmptyParameter() {
  flowChart?.series[0].setData([], false);
  flowChart?.series[1].setData([], false);
  flowChart?.redraw(false);
  if (flowChart) {
    elements.chartEmptyState.textContent =
      `No ${selectedParameter?.name ?? "parameter"} observations are available for this period.`;
    elements.chartEmptyState.hidden = false;
  }
  elements.chartDescription.textContent = `No ${selectedParameter?.name ?? "parameter"} observations are available for this period.`;
  elements.chartRange.textContent = `Last ${elements.periodSelect.value} days`;
  elements.chartTitle.textContent = `${(selectedParameter?.name ?? "Parameter").toUpperCase()} HISTORY`;
  elements.chart.setAttribute("aria-label", `${selectedParameter?.name ?? "Parameter"} history chart`);
  elements.parameterName.textContent = (selectedParameter?.name ?? "Parameter").toUpperCase();
  elements.unit.textContent = unit ? unit.toUpperCase() : "";
  elements.readingUnit.textContent = unit;
  elements.periodMaxUnit.textContent = unit;
  elements.periodMinUnit.textContent = unit;
  elements.timelineUnit.textContent = unit;
  elements.flowValue.textContent = "—";
  elements.timelineFlow.textContent = "—";
  elements.periodMax.textContent = "—";
  elements.periodMin.textContent = "—";
  elements.observationCount.textContent = "0";
  elements.dataInterval.textContent = "—";
  elements.latestRecord.textContent = "—";
  elements.chartStart.textContent = "—";
  elements.chartEnd.textContent = "—";
  elements.timelineStart.textContent = "—";
  elements.timelineCurrent.textContent = "—";
  elements.timelineEnd.textContent = "—";
  elements.timelineDate.textContent = "No observations available";
  elements.readingTime.textContent = "No observations available";
  elements.changeIndicator.textContent = "—";
  elements.timeline.value = "0";
  elements.timeline.max = "0";
  elements.timeline.disabled = true;
  elements.playButton.disabled = true;
  elements.popupLabel.textContent = `${selectedParameter?.name ?? "Parameter"} · ${station?.id ?? ""}`;
  elements.popupValue.textContent = "No observations available";
  elements.mapFlowValue.textContent = "— CFS";
  elements.mapPlaybackNote.textContent = isDischargeSelected
    ? "PLAY RIPPLES FOLLOW FLOW · ILLUSTRATIVE"
    : "SELECT DISCHARGE TO ANIMATE FLOW";
}

function updateObservation(index) {
  if (!observations.length) return;

  selectedIndex = Math.max(0, Math.min(index, observations.length - 1));
  const current = observations[selectedIndex];
  const previous = observations[Math.max(0, selectedIndex - 1)];
  const formattedValue = formatFlow(current.value);
  const delta = current.value - previous.value;

  elements.timeline.value = String(selectedIndex);
  elements.timelineDate.textContent = formatFullDate(current.date);
  elements.timelineCurrent.textContent = dateFormatter.format(new Date(current.date));
  elements.timelineFlow.textContent = formattedValue;
  elements.flowValue.textContent = formattedValue;
  elements.readingTime.textContent = `Selected · ${dateFormatter.format(new Date(current.date))} PT`;
  elements.changeIndicator.textContent = selectedIndex === 0
    ? "START"
    : `${delta > 0 ? "+" : ""}${formatFlow(delta)}`;
  elements.changeIndicator.classList.toggle("is-negative", delta < 0);
  elements.popupValue.textContent = `${formattedValue} ${unit} · ${dateFormatter.format(new Date(current.date))} PT`;
  if (flowChart) {
    flowChart.series[1].setData(
      [[new Date(current.date).getTime(), current.value]],
      false,
    );
    flowChart.redraw(false);
  }
  if (isDischargeSelected) {
    elements.mapFlowValue.textContent = `${formattedValue} CFS`;
  }

  elements.timeline.setAttribute("max", String(Math.max(observations.length - 1, 0)));

  if (stationMarkerElement && isDischargeSelected) {
    const markerSize = 14 + Math.min(12, (Math.max(0, current.value) / Math.max(maximumObservedValue, 1)) * 12);
    stationMarkerElement.style.setProperty("--marker-size", `${markerSize}px`);
  }
  scheduleLayerRender();
}

function stopPlayback(clearFlowParticle = false) {
  if (playTimer !== null) {
    window.clearInterval(playTimer);
    playTimer = null;
  }

  if (flowAnimationFrame !== null) {
    window.cancelAnimationFrame(flowAnimationFrame);
    flowAnimationFrame = null;
  }
  lastFlowFrameTime = null;
  if (clearFlowParticle) {
    clearFlowParticles();
  }
  updateFlowParticleVisibility();
  elements.playButton.setAttribute("aria-label", "Play observations");
  elements.playIcon.innerHTML = '<path d="M6 3.5v13l10-6.5-10-6.5Z" fill="currentColor"/>';
}

function startPlayback() {
  if (observations.length < 2) return;
  if (selectedIndex >= observations.length - 1) updateObservation(0);

  elements.playButton.setAttribute("aria-label", "Pause observations");
  elements.playIcon.innerHTML = '<path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z" fill="currentColor"/>';
  playTimer = window.setInterval(() => {
    const step = Number(elements.speedSelect.value);
    const nextIndex = selectedIndex + step;
    if (nextIndex >= observations.length - 1) {
      updateObservation(observations.length - 1);
      stopPlayback();
      return;
    }
    updateObservation(nextIndex);
  }, 200);
  startFlowAnimation();
}

function updateFlowParticleVisibility() {
  if (!map) return;
  const visibility = isDischargeSelected && elements.streamsToggle.checked && flowParticles.length
    ? "visible"
    : "none";
  for (const layerId of ["flow-ripple-wave", "flow-ripple-core"]) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
  }
}

function clearFlowParticles(resetDistance = true) {
  flowParticles = [];
  if (resetDistance) flowDistanceMeters = 0;
  map?.getSource("flow-ripples")?.setData({
    type: "FeatureCollection",
    features: [],
  });
}

function getActiveReachPaths() {
  if (!map || !stationPosition || !map.isSourceLoaded("streams")) return [];

  const candidates = [];
  const seenPaths = new Set();
  for (const feature of map.querySourceFeatures("streams", { sourceLayer: "streams" })) {
    const reachId = Number(feature.properties?.reach_id);
    if (!Number.isSafeInteger(reachId)) continue;
    if (activeReachId !== null && reachId !== activeReachId) continue;
    const direction = Number(feature.properties?.flowdir);
    if (direction !== 1 && direction !== 2) continue;

    const lineGroups = feature.geometry.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry.type === "MultiLineString"
        ? feature.geometry.coordinates
        : [];
    for (const line of lineGroups) {
      const coordinates = line.filter((point) =>
        Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
      if (coordinates.length < 2) continue;
      let totalLength = 0;
      for (let index = 1; index < coordinates.length; index += 1) {
        const segmentLength = distanceBetween(coordinates[index - 1], coordinates[index]);
        totalLength += segmentLength;
      }
      if (totalLength === 0) continue;

      const endpoints = [
        coordinates[0].map((value) => value.toFixed(5)).join(","),
        coordinates.at(-1).map((value) => value.toFixed(5)).join(","),
      ].sort();
      const signature = `${reachId}:${endpoints.join("|")}:${Math.round(totalLength)}`;
      if (seenPaths.has(signature)) continue;
      seenPaths.add(signature);

      const nearestDistance = nearestDistanceToLine(coordinates, stationPosition);
      candidates.push({
        // USGS flowdir 2 runs opposite to the digitized coordinate order.
        coordinates: direction === 2 ? [...coordinates].reverse() : coordinates,
        nearestDistance,
        reachId,
        matchesName: feature.properties?.name_key === activeReachName,
      });
    }
  }

  candidates.sort((left, right) =>
    Number(right.matchesName) - Number(left.matchesName) ||
    left.nearestDistance - right.nearestDistance);
  if (!candidates.length) return [];

  const selectedReachId = activeReachId ?? candidates[0].reachId;
  return stitchFlowPaths(candidates.filter((path) => path.reachId === selectedReachId))
    .sort((left, right) => left.nearestDistance - right.nearestDistance)
    .slice(0, 1);
}

function stitchFlowPaths(fragments) {
  const pending = fragments.map((fragment) => [...fragment.coordinates]);
  const paths = [];
  while (pending.length) {
    let coordinates = pending.shift();
    let extended = true;
    while (extended) {
      extended = false;
      const nextIndex = pending.findIndex((fragment) =>
        distanceBetween(coordinates.at(-1), fragment[0]) <= 5);
      if (nextIndex !== -1) {
        coordinates = [...coordinates, ...pending.splice(nextIndex, 1)[0].slice(1)];
        extended = true;
        continue;
      }

      const previousIndex = pending.findIndex((fragment) =>
        distanceBetween(fragment.at(-1), coordinates[0]) <= 5);
      if (previousIndex !== -1) {
        coordinates = [
          ...pending.splice(previousIndex, 1)[0].slice(0, -1),
          ...coordinates,
        ];
        extended = true;
      }
    }

    const segmentLengths = [];
    let totalLength = 0;
    for (let index = 1; index < coordinates.length; index += 1) {
      const segmentLength = distanceBetween(coordinates[index - 1], coordinates[index]);
      segmentLengths.push(segmentLength);
      totalLength += segmentLength;
    }
    if (totalLength > 0) {
      paths.push({
        coordinates,
        segmentLengths,
        totalLength,
        nearestDistance: nearestDistanceToLine(coordinates, stationPosition),
        reachId: fragments[0].reachId,
      });
    }
  }
  return paths;
}

function updateActiveReach() {
  if (!map || activeReachId !== null) return;
  const paths = getActiveReachPaths();
  if (!paths.length) return;
  flowPaths = paths;
  activeReachId = paths[0].reachId;
  updateWaterWall();
  for (const layerId of ["active-stream-glow", "active-stream-core"]) {
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, activeReachFilter());
    }
  }
}

function distanceBetween(left, right) {
  const radians = Math.PI / 180;
  const latitude1 = left[1] * radians;
  const latitude2 = right[1] * radians;
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = (right[0] - left[0]) * radians;
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function nearestDistanceToLine(coordinates, point) {
  const radians = Math.PI / 180;
  const latitudeScale = Math.cos(point[1] * radians);
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    const startX = start[0] * latitudeScale;
    const endX = end[0] * latitudeScale;
    const pointX = point[0] * latitudeScale;
    const deltaX = endX - startX;
    const deltaY = end[1] - start[1];
    const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY;
    const fraction = segmentLengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1,
        ((pointX - startX) * deltaX + (point[1] - start[1]) * deltaY) /
          segmentLengthSquared));
    const closestPoint = [
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ];
    nearestDistance = Math.min(nearestDistance, distanceBetween(closestPoint, point));
  }
  return nearestDistance;
}

function positionAlongFlowPath(path, distance) {
  const targetDistance = distance % path.totalLength;
  let distanceBeforeSegment = 0;
  for (let index = 0; index < path.segmentLengths.length; index += 1) {
    const segmentLength = path.segmentLengths[index];
    if (targetDistance <= distanceBeforeSegment + segmentLength || index === path.segmentLengths.length - 1) {
      const segmentProgress = segmentLength === 0
        ? 0
        : (targetDistance - distanceBeforeSegment) / segmentLength;
      const start = path.coordinates[index];
      const end = path.coordinates[index + 1];
      return {
        coordinates: [
          start[0] + (end[0] - start[0]) * segmentProgress,
          start[1] + (end[1] - start[1]) * segmentProgress,
        ],
      };
    }
    distanceBeforeSegment += segmentLength;
  }
  return null;
}

function animateFlowParticle(timestamp) {
  if (playTimer === null || !flowParticles.length) return;
  if (lastFlowFrameTime !== null) {
    const elapsedSeconds = Math.min(timestamp - lastFlowFrameTime, 100) / 1000;
    const currentFlow = Math.max(0, observations[selectedIndex]?.value ?? 0);
    const playbackMultiplier = Math.sqrt(Number(elements.speedSelect.value));
    flowDistanceMeters +=
      50 * (currentFlow / Math.max(maximumObservedValue, 1)) * playbackMultiplier * elapsedSeconds;
  }
  lastFlowFrameTime = timestamp;

  for (const particle of flowParticles) {
    const position = positionAlongFlowPath(
      particle.path,
      flowDistanceMeters + particle.offsetMeters,
    );
    particle.coordinates = position?.coordinates ?? particle.path.coordinates[0];
  }
  updateFlowRippleSource(timestamp);
  flowAnimationFrame = window.requestAnimationFrame(animateFlowParticle);
}

function updateFlowRippleSource(timestamp) {
  const source = map?.getSource("flow-ripples");
  if (!source) return;
  const cycle = timestamp / 1200;
  source.setData({
    type: "FeatureCollection",
    features: flowParticles.map((particle, index) => {
      const phase = (cycle + index / flowParticles.length) % 1;
      return {
        type: "Feature",
        properties: {
          radius: 4 + phase * 12,
          opacity: 1 - phase,
        },
        geometry: {
          type: "Point",
          coordinates: particle.coordinates,
        },
      };
    }),
  });
}

function startFlowAnimation() {
  if (!isDischargeSelected || !map || playTimer === null || !elements.streamsToggle.checked) return;
  if (flowAnimationFrame !== null) return;
  if (!flowPaths?.length) flowPaths = getActiveReachPaths();
  if (!flowPaths.length) {
    map.once("idle", startFlowAnimation);
    return;
  }
  activeReachId = flowPaths[0].reachId;
  for (const layerId of ["active-stream-glow", "active-stream-core"]) {
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, activeReachFilter());
    }
  }

  if (!flowParticles.length) {
    let remainingParticles = 16;
    for (const path of flowPaths) {
      if (remainingParticles <= 0) break;
      const particleCount = Math.min(
        remainingParticles,
        Math.min(10, Math.max(8, Math.floor(path.totalLength / 350))),
      );
      for (let index = 0; index < particleCount; index += 1) {
        const offsetMeters = (path.totalLength * index) / particleCount;
        const position = positionAlongFlowPath(path, offsetMeters);
        flowParticles.push({
          path,
          offsetMeters,
          coordinates: position.coordinates,
        });
        remainingParticles -= 1;
      }
    }
    if (!flowParticles.length) return;
  }

  updateFlowParticleVisibility();
  updateFlowRippleSource(performance.now());
  lastFlowFrameTime = null;
  flowAnimationFrame = window.requestAnimationFrame(animateFlowParticle);
}

function activeReachFilter() {
  return [
    "all",
    activeReachId === null
      ? ["==", ["get", "name_key"], activeReachName]
      : ["==", ["get", "reach_id"], activeReachId],
  ];
}

function createStationMap(coordinates) {
  const position = coordinates ?? [-120.7, 47.4];
  stationPosition = coordinates ?? null;
  activeReachName = normalizeReachName(station?.name ?? "");
  map = new maplibregl.Map({
    container: "map",
    center: position,
    zoom: 7.5,
    pitch: 0,
    maxPitch: 75,
    minZoom: 7,
    maxZoom: 18,
    projection: { type: elements.globeToggle.checked ? "globe" : "mercator" },
    attributionControl: false,
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
        },
        terrain: {
          type: "raster-dem",
          url: "https://tiles.mapterhorn.com/tilejson.json",
          encoding: "terrarium",
          attribution: '&copy; <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">Mapterhorn</a>',
        },
        hillshade: {
          type: "raster-dem",
          url: "https://tiles.mapterhorn.com/tilejson.json",
          encoding: "terrarium",
          attribution: '&copy; <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">Mapterhorn</a>',
        },
        "wria-boundary": {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        streams: {
          type: "vector",
          tiles: [`${window.location.origin}/api/streams/{z}/{x}/{y}.pbf`],
          minzoom: 12,
          maxzoom: 16,
          attribution: 'Stream network: <a href="https://www.usgs.gov/national-hydrography" target="_blank" rel="noreferrer">USGS National Hydrography Dataset</a>',
        },
        "flow-ripples": {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        "water-wall": {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        "station-columns": {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
        "rain-drops": {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers: [
        {
          id: "basemap",
          type: "raster",
          source: "osm",
          paint: {
            "raster-saturation": -0.5,
            "raster-brightness-max": 0.72,
          },
        },
        {
          id: "terrain-shade",
          type: "hillshade",
          source: "hillshade",
          paint: {
            "hillshade-shadow-color": "#16221f",
            "hillshade-highlight-color": "#d2dfd1",
            "hillshade-exaggeration": 0.35,
            "hillshade-illumination-direction": 315,
          },
        },
        {
          id: "wria-fill",
          type: "fill",
          source: "wria-boundary",
          paint: {
            "fill-color": "#45d9a1",
            "fill-opacity": 0.12,
          },
        },
        {
          id: "wria-outline",
          type: "line",
          source: "wria-boundary",
          paint: {
            "line-color": "#8af0bf",
            "line-width": 2,
            "line-opacity": 0.9,
          },
        },
        {
          id: "stream-lines",
          type: "line",
          source: "streams",
          "source-layer": "streams",
          minzoom: 12,
          paint: {
            "line-color": "#748f89",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              7, 0.6,
              12, 1.1,
              16, 2.2,
            ],
            "line-opacity": 0.9,
          },
        },
        {
          id: "active-stream-glow",
          type: "line",
          source: "streams",
          "source-layer": "streams",
          minzoom: 12,
          filter: activeReachFilter(),
          paint: {
            "line-color": "#45d9a1",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              7, 3,
              12, 8,
              16, 15,
            ],
            "line-blur": 2.5,
            "line-opacity": 0.38,
          },
        },
        {
          id: "active-stream-core",
          type: "line",
          source: "streams",
          "source-layer": "streams",
          minzoom: 12,
          filter: activeReachFilter(),
          paint: {
            "line-color": "#8af0bf",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              7, 1.8,
              12, 3.2,
              16, 5,
            ],
            "line-opacity": 1,
          },
        },
        {
          id: "water-wall",
          type: "fill-extrusion",
          source: "water-wall",
          paint: {
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-opacity": 0.8,
          },
        },
        {
          id: "station-columns",
          type: "fill-extrusion",
          source: "station-columns",
          paint: {
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-opacity": 0.9,
          },
        },
        {
          id: "rain-drops",
          type: "fill-extrusion",
          source: "rain-drops",
          paint: {
            "fill-extrusion-color": "#bae6fd",
            "fill-extrusion-base": ["get", "base"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-opacity": 0.85,
          },
        },
        {
          id: "flow-ripple-wave",
          type: "circle",
          source: "flow-ripples",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": ["get", "radius"],
            "circle-color": "#d5ffe6",
            "circle-opacity": ["get", "opacity"],
            "circle-stroke-width": 1.5,
            "circle-stroke-color": "#baffd5",
            "circle-stroke-opacity": ["get", "opacity"],
            "circle-pitch-alignment": "map",
          },
        },
        {
          id: "flow-ripple-core",
          type: "circle",
          source: "flow-ripples",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": 2.5,
            "circle-color": "#baffd5",
            "circle-opacity": 0.95,
            "circle-stroke-width": 3,
            "circle-stroke-color": "#29d994",
            "circle-stroke-opacity": 0.65,
            "circle-pitch-alignment": "map",
          },
        },
      ],
    },
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
  map.on("load", () => {
    if (elements.terrainToggle.checked) {
      map.setTerrain({ source: "terrain", exaggeration: 1.25 });
    }
    elements.mapLoading.hidden = true;
    void loadWriaBoundary();
    void loadWriaStations();
  });
  map.on("idle", updateActiveReach);
  map.on("zoomend", updateWaterWall);
  let streamRetries = 0;
  map.on("sourcedata", (event) => {
    if (event.sourceId === "streams" && event.isSourceLoaded && elements.mapError.textContent.startsWith("USGS stream tiles")) {
      elements.mapError.hidden = true;
      streamRetries = 0;
    }
  });
  map.on("error", (event) => {
    console.error("Map rendering error.", event.error);
    if (event.sourceId === "wria-boundary") {
      elements.mapError.textContent = "The selected WRIA boundary could not be displayed.";
      elements.mapError.hidden = false;
    } else if (event.sourceId === "streams") {
      // Failed vector tiles are not retried by MapLibre, so reload the source a few times before warning.
      if (streamRetries < 3) {
        streamRetries += 1;
        window.setTimeout(() => map.getSource("streams")?.reload?.(), 2000 * streamRetries);
        return;
      }
      elements.mapError.textContent = "USGS stream tiles could not be loaded. The globe and terrain are still available.";
      elements.mapError.hidden = false;
    } else if (event.sourceId === "terrain") {
      elements.mapError.textContent = "3D terrain could not be loaded. The basemap and stream network are still available.";
      elements.mapError.hidden = false;
    }
  });

  stationPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 20,
    maxWidth: "240px",
  }).setDOMContent(elements.mapPopup);
  if (coordinates) {
    stationMarkerElement = document.createElement("button");
    stationMarkerElement.className = "gauge-marker";
    stationMarkerElement.type = "button";
    stationMarkerElement.setAttribute("aria-label", `Show ${station?.name ?? "station"} details`);
    stationMarker = new maplibregl.Marker({ element: stationMarkerElement })
      .setLngLat(position)
      .addTo(map);
    stationMarkerElement.addEventListener("click", (event) => {
      event.stopPropagation();
      elements.mapPopup.hidden = false;
      stationPopup.setLngLat(stationPosition).addTo(map);
    });
  }
  map.on("click", () => {
    stationPopup.remove();
    elements.mapPopup.hidden = true;
  });

  document.querySelector("#zoom-in").addEventListener("click", () => {
    map.zoomTo(Math.min(map.getZoom() + 1, 18), { duration: 180 });
  });
  document.querySelector("#zoom-out").addEventListener("click", () => {
    map.zoomTo(Math.max(map.getZoom() - 1, map.getMinZoom()), { duration: 180 });
  });
  document.querySelector("#recenter").addEventListener("click", () => {
    if (!stationPosition) return;
    map.easeTo({ center: stationPosition, zoom: 13, pitch: 48, duration: 450 });
    stationPopup.remove();
  });

  elements.globeToggle.addEventListener("change", () => {
    map.setProjection({ type: elements.globeToggle.checked ? "globe" : "mercator" });
    updateMapScale();
  });
  elements.terrainToggle.addEventListener("change", () => {
    map.setTerrain(elements.terrainToggle.checked
      ? { source: "terrain", exaggeration: 1.25 }
      : null);
  });
  elements.streamsToggle.addEventListener("change", () => {
    const visibility = elements.streamsToggle.checked ? "visible" : "none";
    for (const layerId of ["stream-lines", "active-stream-glow", "active-stream-core"]) {
      map.setLayoutProperty(layerId, "visibility", visibility);
    }
    updateFlowParticleVisibility();
  });
  map.on("moveend", updateMapScale);
  if (coordinates) updateStationMapCoordinates(coordinates);
  updateMapScale();
  elements.mapError.hidden = true;
}

function getSelectedWriaNumber() {
  const match = /^\(#(\d+)\)/.exec(selectedWria?.value ?? "");
  return match ? Number(match[1]) : 0;
}

function getWriaNumberFromValue(value) {
  const match = /^\(#(\d+)\)/.exec(value);
  return match ? Number(match[1]) : 0;
}

async function loadWriaBoundary() {
  if (!map || !selectedWria?.value) return;

  const wriaNumber = getSelectedWriaNumber();
  if (!wriaNumber) {
    console.error("Could not identify the selected WRIA number.", selectedWria.value);
    elements.mapError.textContent = "The selected WRIA boundary could not be displayed.";
    elements.mapError.hidden = false;
    return;
  }

  const query = new URLSearchParams({
    where: `WRIA_NR=${wriaNumber}`,
    outFields: "WRIA_NR,WRIA_NM",
    returnGeometry: "true",
    outSR: "4326",
    maxAllowableOffset: "0.01",
    f: "geojson",
  });
  const url = `https://services.arcgis.com/6lCKYNJLvwTXqrmp/arcgis/rest/services/ECY/FeatureServer/11/query?${query}`;

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const boundary = await response.json();
    if (!response.ok || boundary.error ||
      boundary.type !== "FeatureCollection" ||
      !Array.isArray(boundary.features) ||
      boundary.features.length === 0) {
      throw new Error(boundary.error?.message ?? "The selected WRIA boundary could not be found.");
    }

    map.getSource("wria-boundary").setData(boundary);
    const selectedFeature = boundary.features.find((feature) =>
      Number(feature.properties?.WRIA_NR) === wriaNumber);
    if (!selectedFeature) {
      throw new Error("The WRIA boundary service did not return the selected watershed.");
    }

    const bounds = new maplibregl.LngLatBounds();
    extendBounds(bounds, selectedFeature.geometry?.coordinates);
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 48, maxZoom: 9, duration: 0 });
    }
  } catch (error) {
    console.error("Could not load the selected WRIA boundary.", error);
    elements.mapError.textContent = "The selected WRIA boundary could not be displayed.";
    elements.mapError.hidden = false;
  }
}

function extendBounds(bounds, coordinates) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    bounds.extend(coordinates);
    return;
  }
  for (const item of coordinates) extendBounds(bounds, item);
}

async function loadWriaStations() {
  if (!map || !selectedWria?.value) return;

  try {
    const query = new URLSearchParams({ wria: selectedWria.value });
    let stations;
    for (let attempt = 0; ; attempt += 1) {
      try {
        stations = await fetchJson(`/api/stations?${query}`);
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
    if (!Array.isArray(stations)) {
      throw new Error("Washington Ecology returned an invalid station list.");
    }

    for (const item of stations) {
      const coordinates = item.coordinates;
      if (!Array.isArray(coordinates) ||
        coordinates.length < 2 ||
        !coordinates.slice(0, 2).every(Number.isFinite) ||
        coordinates[0] < -180 ||
        coordinates[0] > 180 ||
        coordinates[1] < -90 ||
        coordinates[1] > 90) {
        continue;
      }
      if (item.id === station?.id && stationMarker) continue;

      const markerElement = document.createElement("button");
      markerElement.className = `catalog-station-marker${item.isActive ? " is-active" : " is-historical"}`;
      markerElement.type = "button";
      markerElement.title = `${item.name} · ${item.id}${item.isActive ? "" : " · historical"}`;
      markerElement.setAttribute(
        "aria-label",
        `Select ${item.name}, station ${item.id}${item.isActive ? "" : ", historical station"}`,
      );
      new maplibregl.Marker({ element: markerElement, anchor: "center" })
        .setLngLat(coordinates.slice(0, 2))
        .addTo(map);
      markerElement.addEventListener("click", (event) => {
        event.stopPropagation();
        const option = Array.from(elements.stationSelect.options).find((entry) => entry.value === item.id);
        if (!option) {
          elements.mapError.textContent = "The selected station is not available in this watershed.";
          elements.mapError.hidden = false;
          return;
        }
        elements.stationSelect.value = item.id;
        elements.stationSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  } catch (error) {
    console.error("Could not load stations for the selected WRIA.", error);
    elements.mapError.textContent = error.message || "Stations in the selected watershed could not be displayed.";
    elements.mapError.hidden = false;
  }
}

function updateMapScale() {
  if (!map) return;
  const zoom = Math.round(map.getZoom() * 10) / 10;
  elements.mapScale.textContent = `${elements.globeToggle.checked ? "GLOBE" : "TERRAIN"} · ZOOM ${zoom}`;
}

function updateStationMapCoordinates(coordinates) {
  const [longitude, latitude] = coordinates;
  const coordinateFormatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
  elements.coordinates.textContent =
    `${coordinateFormatter.format(latitude)}°N, ${coordinateFormatter.format(Math.abs(longitude))}°W`;
  elements.mapScale.textContent =
    `${coordinateFormatter.format(latitude)}°N · ${coordinateFormatter.format(Math.abs(longitude))}°W`;
}

function updateStationMap(coordinates) {
  const [longitude, latitude] = coordinates;
  stationPosition = [longitude, latitude];
  activeReachName = normalizeReachName(station?.name ?? "");
  activeReachId = null;
  clearFlowParticles();
  flowPaths = null;
  if (stationMarker) stationMarker.setLngLat(stationPosition);
  if (stationMarkerElement) {
    stationMarkerElement.setAttribute("aria-label", `Show ${station?.name ?? "station"} details`);
  }
  for (const layerId of ["active-stream-glow", "active-stream-core"]) {
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, activeReachFilter());
    }
  }
  map.once("idle", updateActiveReach);
  updateStationMapCoordinates(coordinates);
  stationPopup.remove();
  elements.mapError.hidden = true;
}

function normalizeReachName(name) {
  return name
    .split(/\s+(?:nr\.?|near|at|@|above|below)\b/i)[0]
    .replace(/\bcr\.?\b/gi, "creek")
    .replace(/\br\.?\b/gi, "river")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function parseObservations(items) {
  return items.map((item) => ({
    date: item.date,
    value: Number(item.value),
  })).filter((item) => Number.isFinite(new Date(item.date).getTime()) && Number.isFinite(item.value));
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.title ?? body.error ?? `Request failed with status ${response.status}.`);
  }
  return body;
}

function isFlowParameter(parameter) {
  return parameter.id === flowParameterId ||
    (!flowParameterId && parameter.name.startsWith("Discharge"));
}

function applyParameter(parameter, results, parameterUnit) {
  selectedParameter = parameter;
  isDischargeSelected = isFlowParameter(parameter);
  unit = isDischargeSelected ? flowUnit : parameterUnit;
  observations = results;
  selectedIndex = Math.max(observations.length - 1, 0);
  elements.parameterName.textContent = parameter.name.toUpperCase();
  elements.popupLabel.textContent = `${parameter.name} · ${station.id}`;
  elements.mapPlaybackNote.textContent = isDischargeSelected
    ? "PLAY RIPPLES FOLLOW FLOW · ILLUSTRATIVE"
    : "SELECT DISCHARGE TO ANIMATE FLOW";
  elements.dataError.hidden = true;
  elements.mapFlowValue.textContent = "— CFS";
  updateFlowParticleVisibility();

  if (observations.length > 0) {
    drawChart();
    setDataStatus("Ecology data loaded", "ready");
  } else {
    drawEmptyParameter();
    setDataStatus("No observations available", "error");
  }
}

async function selectParameter(parameter) {
  stopPlayback(true);
  parameterRequestController?.abort();

  if (isFlowParameter(parameter)) {
    applyParameter(parameter, flowObservations, flowUnit);
    return;
  }

  const controller = new AbortController();
  parameterRequestController = controller;
  elements.dataError.hidden = true;
  setDataStatus(`Loading ${parameter.name}`, "");
  try {
    const query = new URLSearchParams({
      stationId: station.id,
      parameterId: parameter.id,
      days: elements.periodSelect.value,
    });
    const data = await fetchJson(`/api/parameter-observations?${query}`, controller.signal);
    applyParameter(parameter, parseObservations(data.observations), data.unit ?? "");
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error(`Could not load ${parameter.name} data.`, error);
    elements.dataError.textContent = error.message || `Could not load ${parameter.name} data.`;
    elements.dataError.hidden = false;
    setDataStatus("Parameter data unavailable", "error");
  } finally {
    if (parameterRequestController === controller) {
      parameterRequestController = null;
    }
  }
}

async function loadStationParameters() {
  const query = new URLSearchParams({ stationId: station.id });
  const parameters = await fetchJson(`/api/parameters?${query}`);
  if (!Array.isArray(parameters)) {
    throw new Error("Washington Ecology returned an invalid parameter list.");
  }
  stationParameters = parameters;
  setupComparison(station.id, parameters);

  if (parameters.length === 0) {
    throw new Error("No parameters are listed for this station.");
  }

  const defaultFlowParameter = parameters.find((parameter) =>
    parameter.name.startsWith("Discharge"));
  flowParameterId = defaultFlowParameter?.id ?? "";
  const selected = defaultFlowParameter ?? parameters[0];
  renderLayerList();
  if (isFlowParameter(selected)) {
    applyParameter(selected, flowObservations, flowUnit);
  } else {
    await selectParameter(selected);
  }
  restoreLayersFromUrl();
  await loadAllParameterData();
}

async function initializeDashboard() {
  createFlowChart();

  let initialState;
  const serverDataError = elements.dataError.textContent.trim();
  try {
    initialState = JSON.parse(document.querySelector("#dashboard-state").textContent);
  } catch (error) {
    console.error("Could not read the server-rendered dashboard state.", error);
    setLoadingError("The dashboard data could not be initialized.");
    return;
  }

  selectedWria = {
    value: initialState.wriaValue,
    name: initialState.wriaName,
  };
  if (!initialState.station) {
    setDataStatus(initialState.hasError ? "Data unavailable" : "No station selected", initialState.hasError ? "error" : "");
    return;
  }

  const coordinates = Array.isArray(initialState.station.coordinates) &&
    initialState.station.coordinates.length >= 2 &&
    initialState.station.coordinates.every(Number.isFinite)
    ? initialState.station.coordinates
    : null;
  station = { ...initialState.station, coordinates };
  elements.stationId.textContent = station.id;
  elements.stationName.textContent = station.name;
  elements.stationSubtitle.textContent =
    `${selectedWria.name} · ${station.isActive ? "active telemetry" : "historical station"}`;
  elements.mapKickerStation.textContent = station.id;
  elements.stationStatusLabel.textContent = station.isActive ? "ACTIVE" : "HISTORICAL";
  elements.recordBadge.classList.toggle("is-historical", !station.isActive);
  elements.popupLabel.textContent = `${station.isActive ? "STREAMFLOW GAUGE" : "HISTORICAL GAUGE"} · ${station.id}`;
  elements.popupName.textContent = station.name;

  if (initialState.flow) {
    flowUnit = initialState.flow.unit || flowUnit;
    unit = flowUnit;
    flowObservations = parseObservations(initialState.flow.observations);
    observations = flowObservations;
    elements.sourceLink.href = initialState.flow.sourceUrl;
  }
  selectedParameter = { id: "", name: "Discharge" };

  createStationMap(coordinates);

  if (observations.length > 0) {
    selectedIndex = observations.length - 1;
    drawChart();
  } else {
    drawEmptyParameter();
  }

  try {
    await loadStationParameters();
  } catch (error) {
    console.error("Could not load station parameters.", error);
    elements.dataError.textContent = error.message || "Could not load station parameters.";
    elements.dataError.hidden = false;
    setDataStatus("Station parameters unavailable", "error");
    return;
  }

  if (initialState.hasError && isDischargeSelected) {
    if (serverDataError) {
      elements.dataError.textContent = serverDataError;
      elements.dataError.hidden = false;
    }
    setDataStatus("Data unavailable", "error");
  }
}

elements.timeline.addEventListener("input", () => {
  stopPlayback(true);
  updateObservation(Number(elements.timeline.value));
});
elements.playButton.addEventListener("click", () => {
  if (playTimer !== null) stopPlayback();
  else startPlayback();
});
elements.periodSelect.addEventListener("change", () => elements.filterForm.requestSubmit());

const defaultHeights = { history: 132, comparison: 260, parameter: 48 };
const chartHeights = { history: defaultHeights.history, comparison: defaultHeights.comparison, parameters: new Map() };
let heightResizeFrame = null;
let chartDrag = null;

function parameterHeightKey(card) {
  return JSON.stringify([station?.id ?? "", card.dataset.cardKey]);
}

function applyParameterChartHeight(card) {
  const handle = card.querySelector('[data-chart-resize="parameter"]');
  if (!handle) return;
  const height = chartHeights.parameters.get(parameterHeightKey(card)) ?? defaultHeights.parameter;
  card.style.setProperty("--parameter-height", `${height}px`);
  handle.setAttribute("aria-valuenow", String(height));
  handle.setAttribute("aria-valuetext", `${height} pixels`);
}

function applyChartHeights() {
  for (const type of ["history", "comparison"]) {
    const height = chartHeights[type];
    document.documentElement.style.setProperty(`--${type}-height`, `${height}px`);
    const handle = document.querySelector(`[data-chart-resize="${type}"]`);
    handle.setAttribute("aria-valuenow", String(height));
    handle.setAttribute("aria-valuetext", `${height} pixels`);
  }
  elements.layerCards.querySelectorAll("details[data-card-key]").forEach(applyParameterChartHeight);
  if (heightResizeFrame !== null) window.cancelAnimationFrame(heightResizeFrame);
  heightResizeFrame = window.requestAnimationFrame(() => {
    heightResizeFrame = null;
    window.Highcharts?.charts.forEach((chart) => {
      if (chart?.renderTo.getClientRects().length) chart.setSize(null, null, false);
    });
  });
}

function resizeChart(handle, requestedHeight) {
  const type = handle.dataset.chartResize;
  const height = Math.round(Math.max(Number(handle.getAttribute("aria-valuemin")),
    Math.min(Number(handle.getAttribute("aria-valuemax")), requestedHeight)));
  if (type === "parameter") {
    const card = handle.closest("details[data-card-key]");
    chartHeights.parameters.set(parameterHeightKey(card), height);
    applyParameterChartHeight(card);
  } else {
    chartHeights[type] = height;
    applyChartHeights();
  }
}

document.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-chart-resize]");
  if (!handle || event.button !== 0) return;
  event.preventDefault();
  handle.focus();
  handle.setPointerCapture(event.pointerId);
  chartDrag = { handle, pointerId: event.pointerId, startY: event.clientY, height: Number(handle.getAttribute("aria-valuenow")) };
});

document.addEventListener("pointermove", (event) => {
  if (chartDrag?.pointerId !== event.pointerId) return;
  resizeChart(chartDrag.handle, chartDrag.height + event.clientY - chartDrag.startY);
});

document.addEventListener("pointerup", (event) => {
  if (chartDrag?.pointerId === event.pointerId) chartDrag = null;
});
document.addEventListener("pointercancel", (event) => {
  if (chartDrag?.pointerId === event.pointerId) chartDrag = null;
});

document.addEventListener("keydown", (event) => {
  const handle = event.target.closest("[data-chart-resize]");
  if (!handle) return;
  const height = Number(handle.getAttribute("aria-valuenow"));
  const step = event.shiftKey ? 40 : 10;
  const values = {
    ArrowUp: height - step,
    ArrowDown: height + step,
    Home: Number(handle.getAttribute("aria-valuemin")),
    End: Number(handle.getAttribute("aria-valuemax")),
  };
  if (!Object.hasOwn(values, event.key)) return;
  event.preventDefault();
  resizeChart(handle, values[event.key]);
});

applyChartHeights();
document.querySelector("#chart-settings").hidden = false;
document.documentElement.classList.add("chart-resize-enabled");

// Tab switching functionality
function setupTabSwitching() {
  const tabButtons = document.querySelectorAll(".tab-button");
  const tabContents = document.querySelectorAll(".tab-content");

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = button.getAttribute("data-tab");
      
      // Update button states
      tabButtons.forEach((btn) => {
        btn.setAttribute("aria-selected", String(btn === button));
      });

      // Update tab content visibility
      tabContents.forEach((content) => {
        if (content.id === `${tabId}-tab`) {
          content.hidden = false;
        } else {
          content.hidden = true;
        }
      });

      // Trigger chart resize if switching to flow tab
      if (tabId === "flow") {
        setTimeout(() => {
          window.Highcharts?.charts.forEach((chart) => {
            if (chart?.renderTo.getClientRects().length) chart.setSize(null, null, false);
          });
        }, 50);
      }
    });
  });
}

setupTabSwitching();

const selectorPanel = document.querySelector("#selector-panel");
const selectorToggle = document.querySelector("#selector-toggle");
const appShell = document.querySelector(".app-shell");
const viewSwitcher = document.querySelector(".view-switcher");
const viewButtons = viewSwitcher.querySelectorAll("[data-view-option]");
const viewInput = document.querySelector("#view-input");
const mapColumn = document.querySelector("#map-column");
const inspectorColumn = document.querySelector("#inspector-column");
const mapRegion = document.querySelector(".map-region");
const mapHeading = document.querySelector(".map-heading");
const mapSelectionHint = document.querySelector(".map-selection-hint");
const inspector = document.querySelector(".inspector");
const inspectorHeading = document.querySelector(".inspector-heading");

function setWorkspaceView(view) {
  const selectedView = ["split", "map", "dashboard"].includes(view) ? view : "split";
  appShell.dataset.view = selectedView;
  mapColumn.hidden = selectedView === "dashboard";
  inspectorColumn.hidden = selectedView === "map";
  viewInput.value = selectedView;
  viewInput.disabled = selectedView === "split";
  for (const button of viewButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.viewOption === selectedView));
  }

  if (selectedView === "dashboard") {
    inspector.insertBefore(mapHeading, inspectorHeading);
    inspector.insertBefore(selectorPanel, inspectorHeading);
  } else {
    mapRegion.insertBefore(mapHeading, mapSelectionHint);
    mapRegion.insertBefore(selectorPanel, mapSelectionHint);
  }

  const url = new URL(window.location.href);
  if (selectedView === "split") url.searchParams.delete("view");
  else url.searchParams.set("view", selectedView);
  window.history.replaceState(window.history.state, "", url);

  window.requestAnimationFrame(() => {
    if (!mapColumn.hidden) map?.resize();
    if (!inspectorColumn.hidden) {
      window.Highcharts?.charts.forEach((chart) => chart?.reflow());
    }
  });
}

for (const button of viewButtons) {
  button.addEventListener("click", () => setWorkspaceView(button.dataset.viewOption));
}
setWorkspaceView(new URLSearchParams(window.location.search).get("view"));
viewSwitcher.hidden = false;

function setSelectorCollapsed(collapsed) {
  selectorPanel.classList.toggle("is-collapsed", collapsed);
  selectorToggle.setAttribute("aria-expanded", String(!collapsed));
  selectorToggle.setAttribute(
    "aria-label",
    `${collapsed ? "Expand" : "Collapse"} watershed and station selectors`,
  );
  selectorToggle.firstElementChild.textContent = collapsed ? "›" : "‹";
  document.querySelector("#selector-fields").inert = collapsed;
  try { localStorage.setItem("selectorCollapsed", collapsed ? "1" : "0"); } catch { /* storage unavailable */ }
}

selectorToggle.addEventListener("click", () =>
  setSelectorCollapsed(!selectorPanel.classList.contains("is-collapsed")));
try {
  if (localStorage.getItem("selectorCollapsed") === "1") setSelectorCollapsed(true);
} catch { /* storage unavailable */ }
elements.filterForm.addEventListener("submit", () => {
  elements.mapLoading.textContent = "Loading station… the first load can take up to a minute";
  elements.mapLoading.hidden = false;
});
elements.wriaSelect.addEventListener("change", () => {
  elements.stationSelect.value = "";
  elements.filterForm.requestSubmit();
});
elements.stationSelect.addEventListener("change", () => {
  elements.filterForm.requestSubmit();
});
window.addEventListener("resize", () => map?.resize());

void initializeDashboard();
