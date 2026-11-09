using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using StreamFlowVisualizer.Models;

namespace StreamFlowVisualizer.Services;

public interface IEcologyCatalogService
{
    Task<IReadOnlyList<WriaItem>> GetWriasAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<StationItem>> GetStationsAsync(
        string wria,
        CancellationToken cancellationToken);
}

public sealed class EcologyCatalogService(
    IHttpClientFactory httpClientFactory,
    ILogger<EcologyCatalogService> logger,
    IMemoryCache? cache = null) : IEcologyCatalogService
{
    private const string WriasCacheKey = "ecology-catalog:wrias";
    private static readonly TimeSpan CatalogCacheDuration = TimeSpan.FromHours(24);
    private const string FlowMonitoringServiceUrl =
        "https://gis.ecology.wa.gov/serverext/rest/services/EAP/FlowMonitoringNetwork/MapServer";

    public async Task<IReadOnlyList<WriaItem>> GetWriasAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (cache is not null && cache.TryGetValue(WriasCacheKey, out IReadOnlyList<WriaItem>? cached) && cached is not null)
        {
            return cached;
        }

        var wrias = await LoadWriasAsync(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        cache?.Set(WriasCacheKey, wrias, CatalogCacheDuration);
        return wrias;
    }

    private Task<IReadOnlyList<WriaItem>> LoadWriasAsync(CancellationToken cancellationToken) =>
        EcologyServiceExecutor.ExecuteAsync(
            logger,
            "Washington Ecology could not provide WRIAs.",
            "Washington Ecology returned WRIAs in an unexpected format.",
            "Washington Ecology did not respond in time.",
            async () =>
            {
                const string url = "https://apps.ecology.wa.gov/continuousflowandwq/StationDetails";
                using var response = await EcologyServiceExecutor.GetResponseAsync(
                    httpClientFactory.CreateClient("Ecology"),
                    url,
                    cancellationToken);
                var html = await response.Content.ReadAsStringAsync(cancellationToken);
                var selectMatch = Regex.Match(
                    html,
                    "<select[^>]*id=[\"']wriaList[\"'][^>]*>(?<options>.*?)</select>",
                    RegexOptions.IgnoreCase | RegexOptions.Singleline);

                if (!selectMatch.Success)
                {
                    logger.LogWarning("Ecology's station page did not contain its WRIA selector.");
                    throw new ExternalDataException(
                        "Washington Ecology returned WRIAs in an unexpected format.",
                        StatusCodes.Status502BadGateway);
                }

                var wrias = Regex.Matches(
                        selectMatch.Groups["options"].Value,
                        "<option[^>]*value=[\"'](?<value>[^\"']+)[\"'][^>]*>(?<name>.*?)</option>",
                        RegexOptions.IgnoreCase | RegexOptions.Singleline)
                    .Cast<Match>()
                    .Select(option =>
                    {
                        var value = WebUtility.HtmlDecode(option.Groups["value"].Value).Trim();
                        var numberMatch = Regex.Match(value, @"\(#(?<number>\d+)\)");
                        var name = WebUtility.HtmlDecode(
                            Regex.Replace(option.Groups["name"].Value, "<.*?>", string.Empty)).Trim();
                        return new WriaItem(
                            numberMatch.Success ? int.Parse(numberMatch.Groups["number"].Value) : 0,
                            name,
                            value);
                    })
                    .Where(wria => wria.Number > 0 && !string.IsNullOrWhiteSpace(wria.Name))
                    .ToArray();

                if (wrias.Length == 0)
                {
                    logger.LogWarning("Ecology's station page contained no usable WRIAs.");
                    throw new ExternalDataException(
                        "Washington Ecology returned WRIAs in an unexpected format.",
                        StatusCodes.Status502BadGateway);
                }

                return (IReadOnlyList<WriaItem>)wrias;
            },
            cancellationToken);

    public async Task<IReadOnlyList<StationItem>> GetStationsAsync(
        string wria,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var cacheKey = $"ecology-catalog:stations:{wria}";
        if (cache is not null && cache.TryGetValue(cacheKey, out IReadOnlyList<StationItem>? cached) && cached is not null)
        {
            return cached;
        }

        var stations = await LoadStationsAsync(wria, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        cache?.Set(cacheKey, stations, CatalogCacheDuration);
        return stations;
    }

    private Task<IReadOnlyList<StationItem>> LoadStationsAsync(
        string wria,
        CancellationToken cancellationToken) =>
        EcologyServiceExecutor.ExecuteAsync(
            logger,
            "Washington Ecology could not provide stations for this WRIA.",
            "Washington Ecology returned stations in an unexpected format.",
            "Washington Ecology did not respond in time.",
            async () =>
            {
                var client = httpClientFactory.CreateClient("Ecology");
                var catalogUrl =
                    "https://apps.ecology.wa.gov/continuousflowandwq/StationDetails/GetStationsByWria" +
                    $"?wria={Uri.EscapeDataString(wria)}";
                using var catalogResponse = await EcologyServiceExecutor.GetResponseAsync(
                    client,
                    catalogUrl,
                    cancellationToken);
                using var catalogData = await JsonDocument.ParseAsync(
                    await catalogResponse.Content.ReadAsStreamAsync(cancellationToken),
                    cancellationToken: cancellationToken);

                if (catalogData.RootElement.ValueKind != JsonValueKind.Array)
                {
                    logger.LogWarning("Ecology returned an invalid station catalog for WRIA {Wria}.", wria);
                    throw new ExternalDataException(
                        "Washington Ecology returned stations in an unexpected format.",
                        StatusCodes.Status502BadGateway);
                }

                var catalogStations = new List<(string Id, string Name, bool IsActive)>();
                foreach (var station in catalogData.RootElement.EnumerateArray())
                {
                    var stationId = station.GetProperty("stationCD").GetString();
                    var stationName = station.GetProperty("stationName").GetString();
                    var activeElement = station.GetProperty("isActive");

                    if (string.IsNullOrWhiteSpace(stationId) ||
                        stationId.Length > 32 ||
                        stationId.Any(character => !char.IsAsciiLetterOrDigit(character)) ||
                        string.IsNullOrWhiteSpace(stationName) ||
                        activeElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        logger.LogWarning("Ecology returned an invalid station entry for WRIA {Wria}.", wria);
                        throw new ExternalDataException(
                            "Washington Ecology returned stations in an unexpected format.",
                            StatusCodes.Status502BadGateway);
                    }

                    catalogStations.Add((stationId, stationName, activeElement.GetBoolean()));
                }

                if (catalogStations.Count == 0)
                {
                    return (IReadOnlyList<StationItem>)Array.Empty<StationItem>();
                }

                var stationIds = string.Join(",", catalogStations.Select(station => $"'{station.Id}'"));
                var where = Uri.EscapeDataString($"StationID IN ({stationIds})");
                var locationUrl = FlowMonitoringServiceUrl +
                    $"/0/query?where={where}&outFields=StationID%2CIsStreamflow&returnGeometry=true&outSR=4326&f=json";
                using var locationResponse = await EcologyServiceExecutor.GetResponseAsync(
                    client,
                    locationUrl,
                    cancellationToken);
                using var locationData = await JsonDocument.ParseAsync(
                    await locationResponse.Content.ReadAsStreamAsync(cancellationToken),
                    cancellationToken: cancellationToken);

                if (!locationData.RootElement.TryGetProperty("features", out var locationFeatures) ||
                    locationFeatures.ValueKind != JsonValueKind.Array)
                {
                    logger.LogWarning("Ecology returned invalid station locations for WRIA {Wria}.", wria);
                    throw new ExternalDataException(
                        "Washington Ecology returned station locations in an unexpected format.",
                        StatusCodes.Status502BadGateway);
                }

                var coordinatesByStationId = new Dictionary<string, double[]>(StringComparer.OrdinalIgnoreCase);
                var streamflowStationIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var feature in locationFeatures.EnumerateArray())
                {
                    var attributes = feature.GetProperty("attributes");
                    var stationId = attributes.GetProperty("StationID").GetString();
                    if (stationId is null ||
                        !string.Equals(
                            attributes.GetProperty("IsStreamflow").GetString(),
                            "True",
                            StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    streamflowStationIds.Add(stationId);
                    if (feature.TryGetProperty("geometry", out var point) &&
                        point.TryGetProperty("x", out var longitude) &&
                        point.TryGetProperty("y", out var latitude))
                    {
                        coordinatesByStationId[stationId] = [longitude.GetDouble(), latitude.GetDouble()];
                    }
                }

                return (IReadOnlyList<StationItem>)catalogStations
                    .Where(item => streamflowStationIds.Contains(item.Id))
                    .Select(item => new StationItem(
                        item.Id,
                        item.Name,
                        item.IsActive,
                        coordinatesByStationId.GetValueOrDefault(item.Id)))
                    .ToArray();
            },
            cancellationToken);
}
