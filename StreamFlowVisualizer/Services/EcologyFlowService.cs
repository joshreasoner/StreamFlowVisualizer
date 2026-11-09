using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using StreamFlowVisualizer.Models;

namespace StreamFlowVisualizer.Services;

public interface IFlowDataService
{
    Task<FlowResponse> GetFlowAsync(
        string stationId,
        int days,
        CancellationToken cancellationToken);

    Task<IReadOnlyList<StationParameter>> GetParametersAsync(
        string stationId,
        CancellationToken cancellationToken);

    Task<ParameterResponse> GetParameterDataAsync(
        string stationId,
        string parameterId,
        int days,
        CancellationToken cancellationToken);

    Task<ParameterResponse> GetParameterDataAsync(
        string stationId,
        string parameterId,
        DateOnly periodStart,
        DateOnly periodEnd,
        CancellationToken cancellationToken);
}

public sealed class EcologyFlowService(
    IHttpClientFactory httpClientFactory,
    ILogger<EcologyFlowService> logger,
    IMemoryCache? cache = null) : IFlowDataService
{
    private static readonly SemaphoreSlim UpstreamGate = new(4);
    private static readonly TimeSpan ParameterListCacheDuration = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan ParameterDataCacheDuration = TimeSpan.FromMinutes(2);

    private const string FlowMonitoringServiceUrl =
        "https://gis.ecology.wa.gov/serverext/rest/services/EAP/FlowMonitoringNetwork/MapServer";

    public Task<FlowResponse> GetFlowAsync(
        string stationId,
        int days,
        CancellationToken cancellationToken) =>
        EcologyServiceExecutor.ExecuteAsync(
            logger,
            "Washington Ecology could not provide streamflow data.",
            "Washington Ecology returned streamflow data in an unexpected format.",
            "Washington Ecology did not respond in time.",
            async () =>
            {
                var client = httpClientFactory.CreateClient("Ecology");
                var stationPageUrl =
                    $"https://apps.ecology.wa.gov/continuousflowandwq/StationDetails?sta={Uri.EscapeDataString(stationId)}";
                using var stationPageResponse = await EcologyServiceExecutor.GetResponseAsync(
                    client,
                    stationPageUrl,
                    cancellationToken);
                var stationPage = await stationPageResponse.Content.ReadAsStringAsync(cancellationToken);
                var dischargeParameter = ParseParameters(stationPage).FirstOrDefault(parameter =>
                    parameter.Name.StartsWith("Discharge", StringComparison.OrdinalIgnoreCase));

                if (dischargeParameter is null)
                {
                    logger.LogWarning("Ecology did not list a discharge parameter for station {StationId}.", stationId);
                    throw new ExternalDataException(
                        "No discharge data is available for this station.",
                        StatusCodes.Status404NotFound);
                }

                var parameterData = await ReadParameterDataAsync(
                    client,
                    stationId,
                    dischargeParameter,
                    days,
                    cancellationToken);
                var series = parameterData.Series;
                var discharge = series?.FirstOrDefault(item =>
                    string.Equals(
                        item.Description.ParameterIdentifier,
                        "Discharge",
                        StringComparison.OrdinalIgnoreCase));
                if (discharge is null)
                {
                    logger.LogWarning("Ecology did not return a discharge series for station {StationId}.", stationId);
                    throw new ExternalDataException(
                        "Washington Ecology returned streamflow data in an unexpected format.",
                        StatusCodes.Status502BadGateway);
                }

                var stationUrl = FlowMonitoringServiceUrl +
                    $"/0/query?where={Uri.EscapeDataString($"StationID='{stationId}'")}" +
                    "&outFields=StationID%2CStationName&returnGeometry=true&outSR=4326&f=geojson";
                using var stationResponse = await EcologyServiceExecutor.GetResponseAsync(
                    client,
                    stationUrl,
                    cancellationToken);
                var stationData = await stationResponse.Content.ReadFromJsonAsync<EcologyStationCollection>(
                    cancellationToken: cancellationToken);
                var stationFeature = stationData?.Features.FirstOrDefault();
                var coordinates = stationFeature?.Geometry?.Coordinates;
                if (coordinates is not { Length: >= 2 })
                {
                    logger.LogInformation(
                        "No current map coordinates are available for station {StationId}.",
                        stationId);
                    coordinates = null;
                }

                return new FlowResponse(
                    new StationSummary(
                        stationFeature?.Properties?.StationId ?? stationId,
                        stationFeature?.Properties?.StationName ?? stationId,
                        coordinates),
                    discharge.Description.Unit,
                    parameterData.PeriodStart,
                    discharge.Description.PeriodEnd,
                    $"https://apps.ecology.wa.gov/continuousflowandwq/StationDetails?sta={Uri.EscapeDataString(stationId)}",
                    discharge.Results.Select(result => new FlowObservation(
                        result.Date,
                        result.Value,
                        discharge.Description.Approvals.GetValueOrDefault(result.ApprovalCode.ToString())))
                        .ToArray());
            },
            cancellationToken);

    public Task<IReadOnlyList<StationParameter>> GetParametersAsync(
        string stationId,
        CancellationToken cancellationToken) =>
        EcologyServiceExecutor.ExecuteAsync(
            logger,
            "Washington Ecology could not provide station parameters.",
            "Washington Ecology returned station parameters in an unexpected format.",
            "Washington Ecology did not respond in time.",
            async () =>
            {
                var parameters = await LoadParametersAsync(
                    httpClientFactory.CreateClient("Ecology"),
                    stationId,
                    cancellationToken);
                return (IReadOnlyList<StationParameter>)parameters;
            },
            cancellationToken);

    public Task<ParameterResponse> GetParameterDataAsync(
        string stationId,
        string parameterId,
        int days,
        CancellationToken cancellationToken)
    {
        var (start, end) = GetRecentPeriod(days);
        return GetParameterDataAsync(stationId, parameterId, start, end, cancellationToken);
    }

    public Task<ParameterResponse> GetParameterDataAsync(
        string stationId,
        string parameterId,
        DateOnly periodStart,
        DateOnly periodEnd,
        CancellationToken cancellationToken) =>
        EcologyServiceExecutor.ExecuteAsync(
            logger,
            "Washington Ecology could not provide parameter data.",
            "Washington Ecology returned parameter data in an unexpected format.",
            "Washington Ecology did not respond in time.",
            async () =>
            {
                var client = httpClientFactory.CreateClient("Ecology");
                var parameters = await LoadParametersAsync(client, stationId, cancellationToken);
                var parameter = parameters.FirstOrDefault(item =>
                    string.Equals(item.Id, parameterId, StringComparison.Ordinal));
                if (parameter is null)
                {
                    throw new ExternalDataException(
                        "Choose a parameter available at this station.",
                        StatusCodes.Status400BadRequest);
                }

                var parameterData = await ReadParameterDataAsync(
                    client,
                    stationId,
                    parameter,
                    periodStart,
                    periodEnd,
                    cancellationToken);
                var selectedSeries = parameterData.Series?.FirstOrDefault();
                return new ParameterResponse(
                    parameter.Id,
                    parameter.Name,
                    selectedSeries?.Description.Unit ?? string.Empty,
                    parameterData.PeriodStart,
                    $"https://apps.ecology.wa.gov/continuousflowandwq/StationDetails?sta={Uri.EscapeDataString(stationId)}",
                    selectedSeries?.Results.Select(result => new FlowObservation(
                        result.Date,
                        result.Value,
                        selectedSeries.Description.Approvals.GetValueOrDefault(result.ApprovalCode.ToString())))
                        .ToArray() ?? []);
            },
            cancellationToken);

    private async Task<IReadOnlyList<StationParameter>> LoadParametersAsync(
        HttpClient client,
        string stationId,
        CancellationToken cancellationToken)
    {
        var cacheKey = $"ecology-parameters:{stationId}";
        if (cache is not null && cache.TryGetValue(cacheKey, out IReadOnlyList<StationParameter>? cached) && cached is not null)
        {
            return cached;
        }

        var parameters = await LoadParametersUncachedAsync(client, stationId, cancellationToken);
        cache?.Set(cacheKey, parameters, ParameterListCacheDuration);
        return parameters;
    }

    private async Task<IReadOnlyList<StationParameter>> LoadParametersUncachedAsync(
        HttpClient client,
        string stationId,
        CancellationToken cancellationToken)
    {
        var stationPageUrl =
            $"https://apps.ecology.wa.gov/continuousflowandwq/StationDetails?sta={Uri.EscapeDataString(stationId)}";
        using var stationPageResponse = await EcologyServiceExecutor.GetResponseAsync(
            client,
            stationPageUrl,
            cancellationToken);
        var stationPage = await stationPageResponse.Content.ReadAsStringAsync(cancellationToken);
        var parameters = ParseParameters(stationPage);
        if (parameters.Count > 0)
        {
            return parameters;
        }

        if (Regex.IsMatch(
            stationPage,
            $@"<title>\s*{Regex.Escape(stationId)}\s*\|\s*Station Information\s*\|",
            RegexOptions.IgnoreCase | RegexOptions.Singleline))
        {
            logger.LogInformation("Ecology lists no parameters for station {StationId}.", stationId);
            return parameters;
        }

        logger.LogWarning(
            "Ecology returned an unrecognized station page without parameters for station {StationId}.",
            stationId);
        throw new ExternalDataException(
            "Washington Ecology returned station parameters in an unexpected format.",
            StatusCodes.Status502BadGateway);
    }

    private static IReadOnlyList<StationParameter> ParseParameters(string stationPage) =>
        Regex.Matches(
                stationPage,
                "<input[^>]*name=[\"']ParamArray[\"'][^>]*>",
                RegexOptions.IgnoreCase | RegexOptions.Singleline)
            .Cast<Match>()
            .Select(input =>
            {
                var idMatch = Regex.Match(
                    input.Value,
                    "\\bvalue=[\"'](?<id>[^\"']+)[\"']",
                    RegexOptions.IgnoreCase);
                if (!idMatch.Success)
                {
                    return null;
                }

                var id = WebUtility.HtmlDecode(idMatch.Groups["id"].Value).Trim();
                var labelMatch = Regex.Match(
                    stationPage,
                    $"<label[^>]*for=[\"']ts-{Regex.Escape(id)}[\"'][^>]*>(?<name>.*?)</label>",
                    RegexOptions.IgnoreCase | RegexOptions.Singleline);
                if (!labelMatch.Success)
                {
                    return null;
                }

                var label = WebUtility.HtmlDecode(
                    Regex.Replace(
                        labelMatch.Groups["name"].Value,
                        "<.*?>",
                        string.Empty,
                        RegexOptions.Singleline));
                label = Regex.Replace(label, @"\s+", " ").Trim();
                var hasRecentData = !Regex.IsMatch(
                    label,
                    @"\s+No (?:recent data|data since)\b",
                    RegexOptions.IgnoreCase);
                var name = Regex.Replace(
                    label,
                    @"\s+No (?:recent data|data since)\b.*$",
                    string.Empty,
                    RegexOptions.IgnoreCase).Trim();
                return string.IsNullOrWhiteSpace(name)
                    ? null
                    : new StationParameter(id, name, hasRecentData);
            })
            .Where(parameter => parameter is not null)
            .Cast<StationParameter>()
            .DistinctBy(parameter => parameter.Id, StringComparer.Ordinal)
            .ToArray();

    private async Task<ParameterSeriesData> ReadParameterDataAsync(
        HttpClient client,
        string stationId,
        StationParameter parameter,
        int days,
        CancellationToken cancellationToken)
    {
        var (start, end) = GetRecentPeriod(days);
        return await ReadParameterDataAsync(client, stationId, parameter, start, end, cancellationToken);
    }

    private static (DateOnly Start, DateOnly End) GetRecentPeriod(int days)
    {
        var pacificTime = TimeZoneInfo.ConvertTime(
            DateTimeOffset.UtcNow,
            TimeZoneInfo.FindSystemTimeZoneById("America/Los_Angeles"));
        var periodEnd = DateOnly.FromDateTime(pacificTime.DateTime);
        return (periodEnd.AddDays(1 - days), periodEnd);
    }

    private async Task<ParameterSeriesData> ReadParameterDataAsync(
        HttpClient client,
        string stationId,
        StationParameter parameter,
        DateOnly periodStart,
        DateOnly periodEnd,
        CancellationToken cancellationToken)
    {
        var cacheKey = $"ecology-data:{stationId}:{parameter.Id}:{periodStart:yyyy-MM-dd}:{periodEnd:yyyy-MM-dd}";
        if (cache is not null && cache.TryGetValue(cacheKey, out ParameterSeriesData? cached) && cached is not null)
        {
            return cached;
        }

        var dataUrl = "https://apps.ecology.wa.gov/continuousflowandwq/StationDetails/ReadDataV2" +
            $"?StationCD={Uri.EscapeDataString(stationId)}&PeriodStart={periodStart:yyyy-MM-dd}&PeriodEnd={periodEnd:yyyy-MM-dd}" +
            $"&ParamArray={Uri.EscapeDataString(parameter.Id)}";
        await UpstreamGate.WaitAsync(cancellationToken);
        try
        {
            using var dataResponse = await EcologyServiceExecutor.GetResponseAsync(
                client,
                dataUrl,
                cancellationToken);
            var series = await dataResponse.Content.ReadFromJsonAsync<List<EcologySeries>>(
                cancellationToken: cancellationToken);
            var result = new ParameterSeriesData(periodStart.ToString("yyyy-MM-dd"), series);
            cache?.Set(cacheKey, result, ParameterDataCacheDuration);
            return result;
        }
        finally
        {
            UpstreamGate.Release();
        }
    }

    private sealed record ParameterSeriesData(
        string PeriodStart,
        List<EcologySeries>? Series);

    private sealed record EcologySeries(
        [property: JsonPropertyName("description")] EcologySeriesDescription Description,
        [property: JsonPropertyName("results")] List<EcologyObservation> Results);

    private sealed record EcologySeriesDescription(
        [property: JsonPropertyName("parameterIdentifier")] string ParameterIdentifier,
        [property: JsonPropertyName("unit")] string Unit,
        [property: JsonPropertyName("periodEnd")] DateTime PeriodEnd,
        [property: JsonPropertyName("approvals")] Dictionary<string, string> Approvals);

    private sealed record EcologyObservation(
        [property: JsonPropertyName("d")] DateTime Date,
        [property: JsonPropertyName("v")] double Value,
        [property: JsonPropertyName("a")] int ApprovalCode);

    private sealed record EcologyStationCollection(
        [property: JsonPropertyName("features")] List<EcologyStationFeature> Features);

    private sealed record EcologyStationFeature(
        [property: JsonPropertyName("geometry")] EcologyPoint? Geometry,
        [property: JsonPropertyName("properties")] EcologyStationProperties? Properties);

    private sealed record EcologyPoint(
        [property: JsonPropertyName("coordinates")] double[] Coordinates);

    private sealed record EcologyStationProperties(
        [property: JsonPropertyName("StationID")] string StationId,
        [property: JsonPropertyName("StationName")] string StationName);
}
