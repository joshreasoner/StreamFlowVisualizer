const pacificDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
});
const pacificParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const colors = ["#a4e1bd", "#6aa7ff", "#ffc568", "#f08ad0", "#57d8ed",
  "#ff8d78", "#c79bff", "#ddd87c", "#b8935f", "#e7ece8", "#7fd9a8", "#5a90d9",
  "#ffb366", "#d97bbf", "#4fc9e0", "#ff7a6a", "#b97bff", "#c9cc70", "#a67d52",
  "#d8dcd0"];
const seasons = {
  winter: { label: "Winter", startMonth: 11, endMonth: 2, startYearOffset: -1 },
  spring: { label: "Spring", startMonth: 2, endMonth: 5, startYearOffset: 0 },
  summer: { label: "Summer", startMonth: 5, endMonth: 8, startYearOffset: 0 },
  fall: { label: "Fall", startMonth: 8, endMonth: 11, startYearOffset: 0 },
};

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function periodBounds(mode, year, month, season) {
  if (mode === "water") {
    return { start: new Date(Date.UTC(year - 1, 9, 1)), end: new Date(Date.UTC(year, 9, 1)) };
  }
  if (mode === "season") {
    const definition = seasons[season];
    return {
      start: new Date(Date.UTC(year + definition.startYearOffset, definition.startMonth, 1)),
      end: new Date(Date.UTC(year, definition.endMonth, 1)),
    };
  }
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) throw new Error("Ecology returned an invalid observation date.");
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return match.slice(1).map((part) => Number(part || 0));
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Ecology returned an invalid observation date.");
  const parts = Object.fromEntries(pacificParts.formatToParts(date).map((part) => [part.type, part.value]));
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].map(Number);
}

function pointData(observations, actualEndYear, anchorEndYear) {
  const points = observations.map((item) => {
    const [year, month, day, hour, minute, second] = dateParts(item.date);
    if (!Number.isFinite(item.value)) throw new Error("Ecology returned an invalid observation value.");
    return {
      x: Date.UTC(anchorEndYear + year - actualEndYear, month - 1, day, hour, minute, second),
      y: item.value,
      custom: { date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} PT`, approval: item.approval },
    };
  }).sort((a, b) => a.x - b.x);
  const intervals = [];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].x > points[i - 1].x) intervals.push(points[i].x - points[i - 1].x);
  }
  intervals.sort((a, b) => a - b);
  const gap = Math.max(6 * 3600000, (intervals[Math.floor(intervals.length / 2)] ?? 0) * 3);
  const result = [];
  for (const point of points) {
    if (result.length && point.x - result.at(-1).x > gap) {
      result.push({ x: result.at(-1).x + 1, y: null });
    }
    result.push(point);
  }
  return result;
}

function quantile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function dailyValues(observations, start, end) {
  const daily = new Map();
  for (const observation of observations) {
    const [year, month, day] = dateParts(observation.date);
    if (!Number.isFinite(observation.value)) throw new Error("Ecology returned an invalid observation value.");
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (date < start || date > end) continue;
    if (!daily.has(date)) daily.set(date, []);
    daily.get(date).push(observation.value);
  }
  return [...daily].map(([date, samples]) => ({
    date, value: quantile(samples.sort((a, b) => a - b), 0.5), readings: samples.length,
  }));
}

function summarize(daily, start, end) {
  const selected = daily.filter((day) => day.date >= start && day.date <= end);
  const values = selected.map((day) => day.value).sort((a, b) => a - b);
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  return {
    values, readings: selected.reduce((total, day) => total + day.readings, 0), observedDays: values.length, days,
    median: values.length ? quantile(values, 0.5) : null,
  };
}

function waterMonths(year) {
  return Array.from({ length: 12 }, (_, index) => {
    const start = new Date(Date.UTC(year - 1, 9 + index, 1));
    const end = new Date(Date.UTC(year - 1, 10 + index, 0));
    return { start: isoDate(start), end: isoDate(end) };
  });
}

function alignedDailySeries(days, endYear) {
  const result = new Map();
  for (const day of days) {
    const [year, month, date] = day.date.split("-").map(Number);
    result.set(Date.UTC(2024 + year - endYear, month - 1, date), day);
  }
  return result;
}

function dailyChartPoints(days, endYear, axisStart, axisEnd) {
  const aligned = alignedDailySeries(days, endYear);
  const points = [];
  for (let x = axisStart; x < axisEnd; x += 86400000) {
    const day = aligned.get(x);
    points.push({ x, y: day?.value ?? null, custom: day ?? null });
  }
  return points;
}

export function setupComparison(stationId, parameters) {
  const panel = document.querySelector("#comparison-panel");
  const parameter = document.querySelector("#comparison-parameter");
  const mode = document.querySelector("#comparison-mode");
  const month = document.querySelector("#comparison-month");
  const season = document.querySelector("#comparison-season");
  const calendarYear = document.querySelector("#comparison-calendar-year");
  const seasonYear = document.querySelector("#comparison-season-year");
  const waterYear = document.querySelector("#comparison-water-year");
  const years = document.querySelector("#comparison-years");
  const view = document.querySelector("#comparison-view");
  const button = document.querySelector("#comparison-load");
  const status = document.querySelector("#comparison-status");
  const chartElement = document.querySelector("#comparison-chart");
  const chartArea = document.querySelector("#comparison-chart-area");
  const tableBody = document.querySelector("#comparison-table-body");
  const today = pacificDate.format(new Date());
  const currentCalendarYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  const currentWaterYear = currentCalendarYear + (currentMonth >= 10 ? 1 : 0);
  month.value = String(currentMonth);
  calendarYear.value = String(currentCalendarYear);
  calendarYear.max = String(currentCalendarYear);
  season.value = currentMonth === 12 || currentMonth <= 2 ? "winter" :
    currentMonth <= 5 ? "spring" : currentMonth <= 8 ? "summer" : "fall";
  seasonYear.value = String(currentCalendarYear + (currentMonth === 12 ? 1 : 0));
  waterYear.value = String(currentWaterYear);
  waterYear.max = String(currentWaterYear);
  for (const item of parameters) {
    parameter.add(new Option(item.name, item.id));
  }
  parameter.disabled = parameters.length === 0;
  button.disabled = parameters.length === 0;
  let chart = null;
  let controller = null;
  let comparison = null;

  function invalidate() {
    controller?.abort();
    controller = null;
    button.disabled = parameters.length === 0;
    chart?.destroy();
    chart = null;
    comparison = null;
    tableBody.replaceChildren();
    chartArea.hidden = true;
    status.textContent = "Choose settings and select Compare.";
  }

  function updateSeasonYearLimits() {
    const max = currentCalendarYear + (season.value === "winter" && currentMonth === 12 ? 1 : 0);
    seasonYear.max = String(max);
    seasonYear.min = season.value === "winter" ? "1901" : "1900";
    if (Number(seasonYear.value) > max) seasonYear.value = String(max);
  }
  updateSeasonYearLimits();

  mode.addEventListener("change", () => {
    const water = mode.value === "water";
    const seasonal = mode.value === "season";
    document.querySelector("#comparison-month-label").hidden = mode.value !== "month";
    document.querySelector("#comparison-season-label").hidden = !seasonal;
    document.querySelector("#comparison-calendar-label").hidden = mode.value !== "month";
    document.querySelector("#comparison-season-year-label").hidden = !seasonal;
    document.querySelector("#comparison-water-label").hidden = !water;
    invalidate();
  });
  season.addEventListener("change", () => {
    updateSeasonYearLimits();
    invalidate();
  });
  for (const input of [parameter, month, calendarYear, seasonYear, waterYear, years]) input.addEventListener("change", invalidate);
  view.addEventListener("change", () => {
    if (!comparison) return;
    try {
      renderComparison();
    } catch (error) {
      console.error("Could not display comparison chart.", error);
      status.textContent = error.message || "Could not display comparison chart.";
    }
  });
  panel.addEventListener("toggle", () => {
    if (!panel.open) invalidate();
  });

  function renderComparison() {
    chart?.destroy();
    chart = null;
    const { windows, results, daily, summaries, monthly, unit, water, seasonal, selectedSeason, axisStart, axisEnd, description } = comparison;
    const heatmap = water && view.value === "summary";
    const box = view.value === "box";
    const moduleType = heatmap ? "heatmap" : box ? "boxplot" : view.value === "band" ? "arearange" : null;
    if (moduleType && !window.Highcharts.seriesTypes[moduleType]) {
      status.textContent = `The ${heatmap ? "heatmap" : box ? "distribution" : "range"} chart module could not be loaded. Select observation lines or reload.`;
      return;
    }

    const yearLabel = (year) => water ? `WY ${year}` : seasonal ? `${seasons[selectedSeason].label} ${year}` : String(year);
    const chronological = windows.map((_, index) => index).reverse();
    const rows = heatmap
      ? windows.flatMap((item, index) => waterMonths(item.year).map((month, monthIndex) => ({
        label: `${yearLabel(item.year)} ${month.start.slice(0, 7)}`,
        summary: monthly[index][monthIndex],
      })))
      : chronological.map((index) => ({ label: yearLabel(windows[index].year), summary: summaries[index] }));
    tableBody.replaceChildren(...rows.map(({ label, summary }) => {
      const row = document.createElement("tr");
      for (const text of [
        label,
        summary.median === null ? "No data" : `${window.Highcharts.numberFormat(summary.median, 2)} ${unit}`,
        `${summary.observedDays} / ${summary.days}`,
        String(summary.readings),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    }));

    const coverage = (summary) => `${summary.observedDays} / ${summary.days} days with readings; ${summary.readings} readings`;
    const categories = (heatmap ? windows.map((_, index) => index) : chronological)
      .map((index) => yearLabel(windows[index].year));
    const shared = {
      chart: { backgroundColor: "transparent", animation: false },
      title: { text: null },
      credits: { enabled: false },
      legend: { itemStyle: { color: "#e7ece8" }, itemHoverStyle: { color: "#fff" } },
      time: { timezone: "UTC" },
      plotOptions: { series: { animation: false, turboThreshold: 0 } },
    };
    let options;
    if (view.value === "lines") {
      options = {
        ...shared,
        chart: { ...shared.chart, zooming: { type: "x" } },
        xAxis: { type: "datetime", min: axisStart, max: axisEnd, labels: { style: { color: "#82908a" }, format: "{value:%b %e}" } },
        yAxis: { title: { text: unit, style: { color: "#82908a" } }, labels: { style: { color: "#82908a" } }, gridLineColor: "#2b3733" },
        tooltip: { formatter() {
          const approval = this.point.custom.approval;
          return `${this.series.name}<br/>${this.point.custom.date}<br/>${window.Highcharts.numberFormat(this.y, 2)} ${unit}${approval ? `<br/>${approval}` : ""}`;
        } },
        plotOptions: { series: { ...shared.plotOptions.series, marker: { enabled: false }, lineWidth: 1.5 } },
        series: windows.map((item, index) => ({
          type: "line", name: yearLabel(item.year), color: colors[index],
          data: pointData(results[index].observations, item.year, 2024),
        })),
      };
    } else if (view.value === "daily" || view.value === "band") {
      const dailyPoints = windows.map((item, index) =>
        dailyChartPoints(daily[index], item.year, axisStart, axisEnd));
      const band = view.value === "band";
      const medianPoints = [];
      const rangePoints = [];
      if (band) {
        for (let index = 0; index < dailyPoints[0].length; index += 1) {
          const x = dailyPoints[0][index].x;
          const values = dailyPoints.map((points) => points[index].y)
            .filter((value) => value !== null).sort((a, b) => a - b);
          const custom = { count: values.length };
          medianPoints.push({ x, y: values.length ? quantile(values, 0.5) : null, custom });
          rangePoints.push({ x, low: values.length >= 2 ? values[0] : null,
            high: values.length >= 2 ? values.at(-1) : null, custom });
        }
      }
      options = {
        ...shared,
        chart: { ...shared.chart, zooming: { type: "x" } },
        xAxis: { type: "datetime", min: axisStart, max: axisEnd, labels: { style: { color: "#82908a" }, format: "{value:%b %e}" } },
        yAxis: { title: { text: unit, style: { color: "#82908a" } }, labels: { style: { color: "#82908a" } }, gridLineColor: "#2b3733" },
        tooltip: { formatter() {
          const point = this.point;
          const date = window.Highcharts.dateFormat("%b %e", this.x);
          if (band) {
            const count = point.custom.count;
            const value = point.series.type === "arearange"
              ? `Range: ${window.Highcharts.numberFormat(point.low, 2)}–${window.Highcharts.numberFormat(point.high, 2)}`
              : `Median: ${window.Highcharts.numberFormat(this.y, 2)}`;
            return `${date}<br/>${value} ${unit}<br/>${count} of ${windows.length} years with readings`;
          }
          return `${this.series.name}<br/>${point.custom.date}<br/>Daily median: ${window.Highcharts.numberFormat(this.y, 2)} ${unit}<br/>${point.custom.readings} readings`;
        } },
        plotOptions: { series: { ...shared.plotOptions.series, marker: { enabled: true, radius: 2 }, lineWidth: 1.5, connectNulls: false } },
        series: band ? [
          { type: "arearange", name: "Across-year min–max", data: rangePoints, color: "#a4e1bd", fillOpacity: 0.2, lineWidth: 0 },
          { type: "line", name: "Across-year median", data: medianPoints, color: "#a4e1bd" },
        ] : windows.map((item, index) => ({
          type: "line", name: yearLabel(item.year), color: colors[index], data: dailyPoints[index],
        })),
      };
    } else if (heatmap) {
      const months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];
      options = {
        ...shared,
        xAxis: { categories: months, labels: { style: { color: "#82908a" } } },
        yAxis: { categories, reversed: true, title: { text: null }, labels: { style: { color: "#82908a" } } },
        colorAxis: { minColor: "#253b38", maxColor: "#a4e1bd", labels: { style: { color: "#82908a" } } },
        tooltip: { formatter() {
          const summary = this.point.custom;
          return `${categories[this.point.y]} ${months[this.point.x]}<br/>Median of daily medians: ${this.point.value === null ? "No data" : `${window.Highcharts.numberFormat(this.point.value, 2)} ${unit}`}<br/>${coverage(summary)}`;
        } },
        series: [{
          type: "heatmap", name: "Median of daily medians", nullColor: "#333b38",
          data: monthly.flatMap((items, yearIndex) => items.map((summary, monthIndex) => ({
            x: monthIndex, y: yearIndex, value: summary.median, custom: summary,
          }))),
        }],
      };
    } else {
      const data = chronological.map((index) => {
        const summary = summaries[index];
        if (summary.median === null) return { y: null, custom: summary };
        if (!box) return { y: summary.median, custom: summary };
        return {
          low: summary.values[0], q1: quantile(summary.values, 0.25), median: summary.median,
          q3: quantile(summary.values, 0.75), high: summary.values.at(-1), custom: summary,
        };
      });
      options = {
        ...shared,
        legend: { enabled: false },
        xAxis: { categories, labels: { style: { color: "#82908a" } } },
        yAxis: { title: { text: unit, style: { color: "#82908a" } }, labels: { style: { color: "#82908a" } }, gridLineColor: "#2b3733" },
        tooltip: { formatter() {
          const summary = this.point.custom;
          const values = box
            ? `Daily medians: min ${window.Highcharts.numberFormat(this.point.low, 2)}, Q1 ${window.Highcharts.numberFormat(this.point.q1, 2)}, median ${window.Highcharts.numberFormat(this.point.median, 2)}, Q3 ${window.Highcharts.numberFormat(this.point.q3, 2)}, max ${window.Highcharts.numberFormat(this.point.high, 2)} ${unit}`
            : `Median of daily medians: ${window.Highcharts.numberFormat(this.y, 2)} ${unit}`;
          return `${this.key}<br/>${values}<br/>${coverage(summary)}`;
        } },
        series: [{ type: box ? "boxplot" : "column", name: box ? "Daily median distribution" : "Median of daily medians", color: "#a4e1bd", data }],
      };
    }
    chart = window.Highcharts.chart(chartElement, options);
    const viewDescription = view.value === "daily"
      ? "Daily lines show each day's median; missing days are gaps."
      : view.value === "band"
        ? "The line is the median across available years for each calendar day; the shaded minimum–maximum range requires at least two years. Missing days are gaps; counts vary."
        : "";
    status.textContent = `${viewDescription} ${description}`.trim();
  }

  button.addEventListener("click", async () => {
    invalidate();
    if (!window.Highcharts) {
      status.textContent = "The chart library could not be loaded. Check your connection and reload.";
      return;
    }
    const water = mode.value === "water";
    const seasonal = mode.value === "season";
    const yearsValue = years.value;
    const latestYear = Number(water ? waterYear.value : seasonal ? seasonYear.value : calendarYear.value);
    const selectedMonth = Number(month.value);
    const selectedSeason = season.value;
    const maximumYear = water ? currentWaterYear : seasonal ? Number(seasonYear.max) : currentCalendarYear;
    const minimumYear = water || (seasonal && selectedSeason === "winter") ? 1901 : 1900;
    const count = yearsValue === "all" ? latestYear - minimumYear + 1 : Number(yearsValue);
    if (!Number.isInteger(latestYear) ||
        latestYear > maximumYear ||
        (yearsValue !== "all" && (!Number.isInteger(count) || count < 2 || count > 20)) ||
        (yearsValue === "all" && (count < 2 || count > 200)) ||
        (mode.value === "month" && (!Number.isInteger(selectedMonth) || selectedMonth < 1 || selectedMonth > 12)) ||
        (seasonal && !Object.hasOwn(seasons, selectedSeason)) ||
        latestYear - count + 1 < minimumYear) {
      status.textContent = "Choose a valid year with all comparison dates in 1900 or later.";
      return;
    }
    const anchorEndYear = 2024;
    const anchor = periodBounds(mode.value, anchorEndYear, selectedMonth, selectedSeason);
    const axisStart = anchor.start.getTime();
    const axisEnd = anchor.end.getTime();
    const windows = Array.from({ length: count }, (_, index) => {
      const year = latestYear - index;
      const bounds = periodBounds(mode.value, year, selectedMonth, selectedSeason);
      return { year, start: isoDate(bounds.start), end: isoDate(new Date(bounds.end.getTime() - 86400000)) };
    });
    const request = new AbortController();
    controller = request;
    status.textContent = "Loading historical observations…";
    button.disabled = true;
    try {
      const results = await Promise.all(windows.map(async (window) => {
        const query = new URLSearchParams({
          stationId, parameterId: parameter.value, start: window.start, end: window.end,
        });
        const response = await fetch(`/api/parameter-history?${query}`, {
          signal: request.signal, headers: { Accept: "application/json" },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.title ?? data.error ?? `Request failed (${response.status}).`);
        if (!Array.isArray(data.observations)) throw new Error("Ecology returned an invalid observation series.");
        return data;
      }));
      if (request.signal.aborted) return;
      const units = new Set(results.filter((item) => item.observations.length).map((item) => item.unit));
      if (units.size > 1) throw new Error("These years use different units and cannot be compared safely.");
      const unit = [...units][0] ?? "";
      const daily = windows.map((item, index) => dailyValues(results[index].observations, item.start, item.end));
      const summaries = windows.map((item, index) => summarize(daily[index], item.start, item.end));
      const monthly = water ? windows.map((item, index) =>
        waterMonths(item.year).map((month) => summarize(daily[index], month.start, month.end))) : [];
      const missing = windows.filter((_, index) => summaries[index].observedDays === 0);
      if (missing.length === windows.length) {
        status.textContent = "No observations are available for the selected years and parameter.";
        return;
      }
      chartArea.hidden = false;
      const periodDescription = water ? "Water years end September 30." :
        seasonal && selectedSeason === "winter" ? "Winter is named for the year it ends." :
        seasonal ? `${seasons[selectedSeason].label} aligns by calendar date.` : "Calendar months align by day.";
      const description = `${periodDescription} Summaries use the median of daily medians, not totals. Coverage counts days with at least one reading, not complete days. ${windows.map((w) => `${water ? "WY " : ""}${w.year}: ${w.start} to ${w.end}`).join("; ")}.${missing.length ? ` No data: ${missing.map((w) => w.year).join(", ")}.` : ""} Current or incomplete periods may have partial data.`;
      comparison = { windows, results, daily, summaries, monthly, unit, water, seasonal, selectedSeason, axisStart, axisEnd, description };
      renderComparison();
    } catch (error) {
      if (error.name === "AbortError") return;
      request.abort();
      console.error("Could not load comparison data.", error);
      status.textContent = error.message || "Could not load historical observations.";
    } finally {
      if (controller === request) {
        controller = null;
        button.disabled = false;
      }
    }
  });
}
