# StreamFlow Visualizer

A .NET 10 ASP.NET Core MVC app that visualizes real-time and recent streamflow at
Washington Department of Ecology monitoring stations.

## Run locally

```powershell
dotnet run --project .\StreamFlowVisualizer.csproj
```

Open the localhost URL printed by ASP.NET Core. Choose a WRIA and streamflow
station to view 7-, 30-, 90-, and 365-day discharge history, a time scrubber, playback,
and a station popup. The MVC `HomeController` renders the page from
`Views/Home/Index.cshtml`. Bootstrap 5 provides the responsive grid and form
controls, Highcharts renders the observation history, and MapLibre GL JS renders
the interactive globe and map in the browser. The dashboard keeps the map,
station details, and playback controls in a single desktop viewport. The app
starts at station **01N060 — Bertrand Creek near mouth**.

Use the **View** controls to switch between the split layout, a map-only view,
and a dashboard-only view. Watershed and station selectors remain available in
either view, and the selected view is preserved when changing filters or sharing
the current URL. Playback controls remain available in all views.

The dashboard selection is server-driven: changing the watershed, station, or
period navigates to `/?wria=...&stationId=...&days=...`. The WRIA and station
selectors are overlaid on the map; stations can also be selected by clicking
their map markers. The map shows the selected WRIA boundary and its mapped
streamflow stations; selecting a station focuses the map on that gauge. These
selections can be bookmarked or shared, and the dashboard data is rendered by
MVC before the interactive chart and map are initialized. JavaScript enhances
chart playback and requests stream vector tiles for the visible map area.
Clicking a chart observation selects that reading in the timeline.

Each station parameter card can be expanded or collapsed, including during
playback. Drag the handle at the bottom of any chart to resize it, or focus the
handle and use the arrow keys (Home and End set the limits). Chart sizes reset
when the page reloads.

The optional **Compare years** panel plots one series per year for any listed
station parameter, including parameters without recent data. Choose a calendar
month, a meteorological season, or a full water year (October 1 through
September 30), and the latest year to compare. Seasons are winter (December
through February), spring (March through May), summer (June through August),
and fall (September through November). Winter and water years are named for
the year they end: winter 2024 starts in December 2023. Choose
2–10 years and select **Compare**; the usual history, map, and playback remain
unchanged. The default summary shows a column per year for a month or season,
or an October–September heatmap for water years. **Original observation lines**
preserves the original chart of individual readings aligned by calendar date.
**Daily median lines** reduce clutter to one value per observed day per year.
**Across-year median and range** shows the median and minimum–maximum band of
daily medians across the selected years for each calendar day. The band requires
at least two years; the tooltip reports the number of contributing years.
**Distribution** shows box plots of daily medians (minimum, quartiles, median,
maximum). Changing views uses the already-loaded data.

Summaries use the median of each day's readings, then the median of those daily
medians within the period or heatmap month; this gives each observed day equal
weight. Values are not rainfall totals. Tooltips and the expandable summary
table show the number of days with at least one observation out of calendar
days, plus the number of readings. A counted day is not necessarily complete.
Current periods and years with gaps may be partial; missing data is not zero.
Missing days break daily lines and the across-year range; February 29 contributes
only in leap years. The across-year median can use just one year and is not a
long-term climatological normal. Original line tooltips show the actual date,
value, and approval. Ecology's historical availability varies by station and
parameter.

The API is handled by `ApiController`. `EcologyCatalogService`,
`EcologyFlowService`, and `HydrographyService` keep external data retrieval and
response parsing separate from controller responsibilities. CSS and JavaScript
are served from `wwwroot`.

Run the controller and external-service tests with:

```powershell
dotnet test .\tests\StreamFlowVisualizer.Tests\StreamFlowVisualizer.Tests.csproj
```

## Data and map services

- `GET /api/wrias` reads the available WRIAs from Ecology's Station Information
  page.
- `GET /api/stations?wria=(%2301)%20Nooksack` reads that WRIA's station catalog
  and returns streamflow stations with their active/historical status and
  available map coordinates.
- `GET /api/flow?stationId=01N060&days=7` fetches that station's discharge
  observations and coordinates from Washington Department of Ecology. `days`
  must be between 1 and 365. The station's discharge parameter is discovered
  from its Ecology station page.
- `GET /api/parameters?stationId=01N060` lists every parameter Ecology publishes
  for that station, including parameters marked as having no recent data.
- `GET /api/parameter-observations?stationId=01N060&parameterId=...&days=7`
  fetches the selected parameter's observations. The dashboard parameter
  selector updates the chart, units, and summary values; the map's CFS gauge
  readout and flow animation remain specific to discharge.
- `GET /api/parameter-history?stationId=01N060&parameterId=...&start=2023-10-01&end=2024-09-30`
  fetches an inclusive historical window of up to 366 days for a listed station
  parameter. Comparison requests one window per year. Errors are reported
  rather than silently omitting failed years.
- `GET /api/streams/{zoom}/{column}/{row}.pbf` fetches the visible tile's
  stream geometry from the USGS National Hydrography Dataset and returns
  Mapbox Vector Tiles. The server clips and simplifies lines per tile and
  caches the encoded response for one hour. The browser requests and renders
  streams from zoom level 12, avoiding USGS tile queries at small scales that
  can exceed the service's feature limit; it highlights the selected USGS reach
  ID, preferring the gauge's
  matching name and otherwise selecting the nearest stream segment. During
  playback, several ripples move along connected pieces of that reach
  currently loaded on the map, in NHD flow direction from the path's start to
  its end. Speed is scaled to the current gauge reading and playback setting.
  Keeping the reach ID and path fixed across zooms avoids switching to
  disconnected lines that happen to share a name. The CFS readout is a gauge
  observation, not a measurement of flow or speed at each point along a creek;
  ripple motion is illustrative, not a measured water velocity. Physical
  velocity would require channel cross-section data.
- The selected WRIA boundary is fetched from the Washington Department of
  Ecology's public ArcGIS feature service. Its streamflow stations with
  coordinates are shown as selectable map markers.
- Historical streamflow stations are included. When a station has no
  observations in the selected recent period, the dashboard reports that
  instead of retaining the previous station's readings.
- Bootstrap 5.3.3, Highcharts 12.4.0 (including Highcharts More and the heatmap
  and accessibility modules), and MapLibre GL JS 6.16.0 are loaded from
  version-pinned browser CDNs; the OpenStreetMap basemap and Mapterhorn
elevation tiles are loaded directly by the browser. These services require
no API key, NuGet package, or NPM package. Follow the
  [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  and show the map attribution. Mapterhorn terrain attribution is provided by
  its TileJSON metadata.
- This application requires an internet connection for the agency data,
  USGS stream geometry, basemap and elevation tiles, and MapLibre GL JS.

Data and map acknowledgments are shown on the map.
