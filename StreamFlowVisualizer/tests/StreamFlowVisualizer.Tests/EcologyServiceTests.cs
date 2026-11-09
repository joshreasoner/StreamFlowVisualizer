using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Internal;
using Microsoft.Extensions.Logging.Abstractions;
using StreamFlowVisualizer.Models;
using StreamFlowVisualizer.Services;
using Xunit;

namespace StreamFlowVisualizer.Tests;

public sealed class EcologyServiceTests
{
    [Fact]
    public async Task CatalogService_FiltersNonStreamflowStationsAndAddsCoordinates()
    {
        var factory = new StubHttpClientFactory(request =>
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("GetStationsByWria", StringComparison.Ordinal))
            {
                return JsonResponse(
                    """
                    [
                      {"stationCD":"01N060","stationName":"Bertrand Creek","isActive":true},
                      {"stationCD":"03A060","stationName":"Water quality only","isActive":true},
                      {"stationCD":"01A140","stationName":"Nooksack River","isActive":false}
                    ]
                    """);
            }

            return JsonResponse(
                """
                {
                  "features": [
                    {"attributes":{"StationID":"01N060","IsStreamflow":"True"},"geometry":{"x":-122.5302,"y":48.9242}},
                    {"attributes":{"StationID":"03A060","IsStreamflow":"False"},"geometry":{"x":-122.5,"y":48.9}},
                    {"attributes":{"StationID":"01A140","IsStreamflow":"True"}}
                  ]
                }
                """);
        });
        var service = new EcologyCatalogService(
            factory,
            NullLogger<EcologyCatalogService>.Instance);

        var stations = await service.GetStationsAsync("(#01) Nooksack", CancellationToken.None);

        Assert.Equal(["01N060", "01A140"], stations.Select(item => item.Id));
        Assert.Equal([-122.5302, 48.9242], Assert.IsType<double[]>(stations[0].Coordinates));
        Assert.True(stations[0].IsActive);
        Assert.False(stations[1].IsActive);
        Assert.Null(stations[1].Coordinates);
    }

    [Fact]
    public async Task CatalogService_ParsesAvailableWrias()
    {
        var factory = new StubHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """
                <select id="wriaList">
                  <option value="(#01) Nooksack">(#01) Nooksack</option>
                  <option value="(#03) Lower Skagit-Samish">(#03) Lower Skagit-Samish</option>
                </select>
                """,
                Encoding.UTF8,
                "text/html")
        });
        var service = new EcologyCatalogService(
            factory,
            NullLogger<EcologyCatalogService>.Instance);

        var wrias = await service.GetWriasAsync(CancellationToken.None);

        Assert.Equal([1, 3], wrias.Select(item => item.Number));
        Assert.Equal("(#01) Nooksack", wrias[0].Value);
        Assert.Equal("(#03) Lower Skagit-Samish", wrias[1].Name);
    }

    [Fact]
    public async Task CatalogService_CachesWriasAcrossServiceInstances()
    {
        var requests = 0;
        var factory = new StubHttpClientFactory(_ =>
        {
            requests++;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""<select id="wriaList"><option value="(#01) Nooksack">(#01) Nooksack</option></select>""")
            };
        });
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var first = new EcologyCatalogService(factory, NullLogger<EcologyCatalogService>.Instance, cache);
        var second = new EcologyCatalogService(factory, NullLogger<EcologyCatalogService>.Instance, cache);

        var firstResult = await first.GetWriasAsync(CancellationToken.None);
        var secondResult = await second.GetWriasAsync(CancellationToken.None);
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => second.GetWriasAsync(canceled.Token));

        Assert.Equal(1, requests);
        Assert.Equal(firstResult, secondResult);
        Assert.Equal("(#01) Nooksack", Assert.Single(secondResult).Value);
    }

    [Fact]
    public async Task CatalogService_DoesNotCacheFailedWriaRequests()
    {
        var requests = 0;
        var factory = new StubHttpClientFactory(_ =>
        {
            requests++;
            return requests == 1
                ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("""<select id="wriaList"><option value="(#01) Nooksack">(#01) Nooksack</option></select>""")
                };
        });
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new EcologyCatalogService(factory, NullLogger<EcologyCatalogService>.Instance, cache);

        await Assert.ThrowsAsync<ExternalDataException>(() => service.GetWriasAsync(CancellationToken.None));
        var wrias = await service.GetWriasAsync(CancellationToken.None);

        Assert.Equal(2, requests);
        Assert.Equal("(#01) Nooksack", Assert.Single(wrias).Value);
    }

    [Fact]
    public async Task CatalogService_DoesNotCacheCanceledWriaRequests()
    {
        var requests = 0;
        using var canceled = new CancellationTokenSource();
        var factory = new StubHttpClientFactory(_ =>
        {
            if (++requests == 1) canceled.Cancel();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""<select id="wriaList"><option value="(#01) Nooksack">(#01) Nooksack</option></select>""")
            };
        });
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new EcologyCatalogService(factory, NullLogger<EcologyCatalogService>.Instance, cache);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.GetWriasAsync(canceled.Token));
        var wrias = await service.GetWriasAsync(CancellationToken.None);

        Assert.Equal(2, requests);
        Assert.Equal("(#01) Nooksack", Assert.Single(wrias).Value);
    }

    [Fact]
    public async Task CatalogService_CachesStationsPerWriaAndServiceInstance()
    {
        var requests = 0;
        var factory = new StubHttpClientFactory(request =>
        {
            requests++;
            if (request.RequestUri!.AbsolutePath.EndsWith("GetStationsByWria", StringComparison.Ordinal))
            {
                var id = request.RequestUri.Query.Contains("Nooksack", StringComparison.Ordinal) ? "01N060" : "03C060";
                return JsonResponse($$"""[{"stationCD":"{{id}}","stationName":"Creek","isActive":true}]""");
            }

            return JsonResponse("""
                {"features":[
                  {"attributes":{"StationID":"01N060","IsStreamflow":"True"},"geometry":{"x":-122.5,"y":48.9}},
                  {"attributes":{"StationID":"03C060","IsStreamflow":"True"},"geometry":{"x":-122.3,"y":48.5}}
                ]}
                """);
        });
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var first = new EcologyCatalogService(factory, NullLogger<EcologyCatalogService>.Instance, cache);
        var second = new EcologyCatalogService(factory, NullLogger<EcologyCatalogService>.Instance, cache);

        var nooksack = await first.GetStationsAsync("(#01) Nooksack", CancellationToken.None);
        var cached = await second.GetStationsAsync("(#01) Nooksack", CancellationToken.None);
        var skagit = await second.GetStationsAsync("(#03) Lower Skagit-Samish", CancellationToken.None);
        using var canceled = new CancellationTokenSource();
        canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => second.GetStationsAsync("(#01) Nooksack", canceled.Token));

        Assert.Equal(4, requests);
        Assert.Equal("01N060", Assert.Single(nooksack).Id);
        Assert.Equal("01N060", Assert.Single(cached).Id);
        Assert.Equal("03C060", Assert.Single(skagit).Id);
    }

    [Fact]
    public async Task CatalogService_DoesNotCacheFailedOrCanceledStationRequests()
    {
        var requests = 0;
        using var canceled = new CancellationTokenSource();
        var factory = new StubHttpClientFactory(_ =>
        {
            requests++;
            if (requests == 1) return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            if (requests == 2) canceled.Cancel();
            return JsonResponse("[]");
        });
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new EcologyCatalogService(factory, NullLogger<EcologyCatalogService>.Instance, cache);

        await Assert.ThrowsAsync<ExternalDataException>(() => service.GetStationsAsync("(#01) Nooksack", CancellationToken.None));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.GetStationsAsync("(#01) Nooksack", canceled.Token));
        Assert.Empty(await service.GetStationsAsync("(#01) Nooksack", CancellationToken.None));
        Assert.Empty(await service.GetStationsAsync("(#01) Nooksack", CancellationToken.None));
        Assert.Equal(3, requests);
    }

    [Fact]
    public async Task CatalogService_ExpiresBothListsAfter24Hours()
    {
        var clock = new TestClock { UtcNow = DateTimeOffset.UtcNow };
        var requests = 0;
        var factory = new StubHttpClientFactory(request =>
        {
            requests++;
            return request.RequestUri!.AbsolutePath.EndsWith("GetStationsByWria", StringComparison.Ordinal)
                ? JsonResponse("[]")
                : new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("""<select id="wriaList"><option value="(#01) Nooksack">(#01) Nooksack</option></select>""")
                };
        });
        using var cache = new MemoryCache(new MemoryCacheOptions { Clock = clock });
        var service = new EcologyCatalogService(factory, NullLogger<EcologyCatalogService>.Instance, cache);

        await service.GetWriasAsync(CancellationToken.None);
        await service.GetStationsAsync("(#01) Nooksack", CancellationToken.None);
        clock.UtcNow = clock.UtcNow.AddHours(23);
        await service.GetWriasAsync(CancellationToken.None);
        await service.GetStationsAsync("(#01) Nooksack", CancellationToken.None);
        Assert.Equal(2, requests);
        clock.UtcNow = clock.UtcNow.AddHours(2);
        await service.GetWriasAsync(CancellationToken.None);
        await service.GetStationsAsync("(#01) Nooksack", CancellationToken.None);
        Assert.Equal(4, requests);
    }

    [Fact]
    public async Task FlowService_DiscoversDischargeAndMapsObservations()
    {
        var requestedUrls = new List<string>();
        var factory = new StubHttpClientFactory(request =>
        {
            var url = request.RequestUri!.ToString();
            requestedUrls.Add(url);
            if (url.Contains("StationDetails?sta=", StringComparison.Ordinal))
            {
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """
                        <input name="ParamArray" value="parameter-123">
                        <label for="ts-parameter-123">Discharge No recent data</label>
                        """)
                };
            }

            if (url.Contains("ReadDataV2", StringComparison.Ordinal))
            {
                return JsonResponse(
                    """
                    [{
                      "description":{
                        "parameterIdentifier":"Discharge",
                        "unit":"ft^3/s",
                        "periodEnd":"2026-11-01T00:00:00",
                        "approvals":{"1":"Approved"}
                      },
                      "results":[{"d":"2026-11-01T06:00:00Z","v":12.5,"a":1}]
                    }]
                    """);
            }

            return JsonResponse(
                """
                {
                  "features":[{
                    "geometry":{"coordinates":[-122.5302,48.9242]},
                    "properties":{"StationID":"01N060","StationName":"Bertrand Creek near mouth"}
                  }]
                }
                """);
        });
        var service = new EcologyFlowService(
            factory,
            NullLogger<EcologyFlowService>.Instance);

        var result = await service.GetFlowAsync("01N060", 7, CancellationToken.None);

        Assert.Equal("01N060", result.Station.Id);
        Assert.Equal("Bertrand Creek near mouth", result.Station.Name);
        Assert.Equal([-122.5302, 48.9242], Assert.IsType<double[]>(result.Station.Coordinates));
        Assert.Equal("ft^3/s", result.Unit);
        var observation = Assert.Single(result.Observations);
        Assert.Equal(12.5, observation.Value);
        Assert.Equal("Approved", observation.Approval);
        Assert.Contains(requestedUrls, url => url.Contains("ParamArray=parameter-123", StringComparison.Ordinal));
        Assert.Contains(requestedUrls, url => url.Contains("PeriodStart=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task FlowService_ListsStationParametersAndMarksStaleOnes()
    {
        var factory = new StubHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """
                <input id="ts-discharge-id" name="ParamArray" value="discharge-id" checked />
                <label class="form-check-label" for="ts-discharge-id">Discharge</label>
                <input id="ts-nitrate-id" name="ParamArray" value="nitrate-id" />
                <label class="form-check-label" for="ts-nitrate-id">
                  Nitrate &#x2B; Nitrite as N
                  <span class="badge"
                        title="No data since 09/12/2017">No recent data</span>
                </label>
                """)
        });
        var service = new EcologyFlowService(
            factory,
            NullLogger<EcologyFlowService>.Instance);

        var parameters = await service.GetParametersAsync("01N060", CancellationToken.None);

        Assert.Equal(2, parameters.Count);
        Assert.Equal(new StationParameter("discharge-id", "Discharge", true), parameters[0]);
        Assert.Equal(
            new StationParameter("nitrate-id", "Nitrate + Nitrite as N", false),
            parameters[1]);
    }

    [Fact]
    public async Task FlowService_ReturnsEmptyParameterListForStationWithoutParameters()
    {
        var factory = new StubHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """
                <!DOCTYPE html>
                <html>
                  <head><title>05E060 | Station Information | Freshwater DataStream</title></head>
                  <body>
                    <h2>Station 05E060 - Armstrong Cr. nr Arlington</h2>
                    <b>Select Parameters</b>
                  </body>
                </html>
                """)
        });
        var service = new EcologyFlowService(
            factory,
            NullLogger<EcologyFlowService>.Instance);

        var parameters = await service.GetParametersAsync("05E060", CancellationToken.None);

        Assert.Empty(parameters);
    }

    [Fact]
    public async Task FlowService_RejectsUnrecognizedStationPageWithoutParameters()
    {
        var factory = new StubHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("<html><body>Service temporarily unavailable</body></html>")
        });
        var service = new EcologyFlowService(
            factory,
            NullLogger<EcologyFlowService>.Instance);

        var exception = await Assert.ThrowsAsync<ExternalDataException>(
            () => service.GetParametersAsync("05E060", CancellationToken.None));

        Assert.Equal(StatusCodes.Status502BadGateway, exception.StatusCode);
    }

    [Fact]
    public async Task FlowService_HistoricalPeriodsUseTheirDatesInRequestsAndCache()
    {
        var requestedUrls = new List<string>();
        var factory = new StubHttpClientFactory(request =>
        {
            var url = request.RequestUri!.ToString();
            requestedUrls.Add(url);
            if (url.Contains("StationDetails?sta=", StringComparison.Ordinal))
            {
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """
                        <input name="ParamArray" value="water-temp-id">
                        <label for="ts-water-temp-id">Water Temp No data since 2020</label>
                        """)
                };
            }

            return JsonResponse(
                """
                [{
                  "description":{"parameterIdentifier":"Water Temp","unit":"degC",
                    "periodEnd":"2024-09-30T00:00:00","approvals":{"1":"Approved"}},
                  "results":[{"d":"2024-02-29T06:00:00","v":8.7,"a":1}]
                }]
                """);
        });
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new EcologyFlowService(factory, NullLogger<EcologyFlowService>.Instance, cache);
        var start = new DateOnly(2023, 10, 1);
        var end = new DateOnly(2024, 9, 30);

        var first = await service.GetParameterDataAsync("01N060", "water-temp-id", start, end, CancellationToken.None);
        await service.GetParameterDataAsync("01N060", "water-temp-id", start, end, CancellationToken.None);
        await service.GetParameterDataAsync("01N060", "water-temp-id", start.AddYears(-1), end.AddYears(-1), CancellationToken.None);

        Assert.Equal("2023-10-01", first.PeriodStart);
        Assert.Equal("Approved", Assert.Single(first.Observations).Approval);
        var dataUrls = requestedUrls.Where(url => url.Contains("ReadDataV2", StringComparison.Ordinal)).ToArray();
        Assert.Equal(2, dataUrls.Length);
        Assert.Contains("PeriodStart=2023-10-01&PeriodEnd=2024-09-30", dataUrls[0]);
        Assert.Contains("PeriodStart=2022-10-01&PeriodEnd=2023-09-30", dataUrls[1]);
    }

    [Fact]
    public async Task FlowService_UsesSelectedStationParameterForObservations()
    {
        var requestedUrls = new List<string>();
        var factory = new StubHttpClientFactory(request =>
        {
            var url = request.RequestUri!.ToString();
            requestedUrls.Add(url);
            if (url.Contains("StationDetails?sta=", StringComparison.Ordinal))
            {
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """
                        <input name="ParamArray" value="water-temp-id">
                        <label for="ts-water-temp-id">Water Temp</label>
                        """)
                };
            }

            return JsonResponse(
                """
                [{
                  "description":{
                    "parameterIdentifier":"Water Temp",
                    "unit":"degC",
                    "periodEnd":"2026-11-01T00:00:00",
                    "approvals":{"1":"Approved"}
                  },
                  "results":[{"d":"2026-11-01T06:00:00Z","v":8.7,"a":1}]
                }]
                """);
        });
        var service = new EcologyFlowService(
            factory,
            NullLogger<EcologyFlowService>.Instance);

        var result = await service.GetParameterDataAsync(
            "01N060",
            "water-temp-id",
            7,
            CancellationToken.None);

        Assert.Equal("water-temp-id", result.ParameterId);
        Assert.Equal("Water Temp", result.ParameterName);
        Assert.Equal("degC", result.Unit);
        Assert.Equal("Approved", Assert.Single(result.Observations).Approval);
        Assert.Contains(
            requestedUrls,
            url => url.Contains("ParamArray=water-temp-id", StringComparison.Ordinal));
    }

    [Fact]
    public async Task FlowService_RejectsParameterNotListedForStation()
    {
        var requestedUrls = new List<string>();
        var factory = new StubHttpClientFactory(request =>
        {
            requestedUrls.Add(request.RequestUri!.ToString());
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """
                    <input name="ParamArray" value="station-parameter">
                    <label for="ts-station-parameter">Water Temp</label>
                    """)
            };
        });
        var service = new EcologyFlowService(
            factory,
            NullLogger<EcologyFlowService>.Instance);

        var exception = await Assert.ThrowsAsync<ExternalDataException>(
            () => service.GetParameterDataAsync(
                "01N060",
                "parameter-from-another-station",
                7,
                CancellationToken.None));

        Assert.Equal(StatusCodes.Status400BadRequest, exception.StatusCode);
        Assert.Single(requestedUrls);
        Assert.DoesNotContain(requestedUrls, url => url.Contains("ReadDataV2", StringComparison.Ordinal));
    }

    [Fact]
    public async Task FlowService_ReturnsEmptyObservationsWhenPeriodHasNoDischargeData()
    {
        var factory = new StubHttpClientFactory(request =>
        {
            var url = request.RequestUri!.ToString();
            if (url.Contains("StationDetails?sta=", StringComparison.Ordinal))
            {
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """
                        <input name="ParamArray" value="parameter-123">
                        <label for="ts-parameter-123">Discharge No recent data</label>
                        """)
                };
            }

            if (url.Contains("ReadDataV2", StringComparison.Ordinal))
            {
                return JsonResponse(
                    """
                    [{
                      "description":{
                        "parameterIdentifier":"Discharge",
                        "unit":"ft^3/s",
                        "periodEnd":"2026-11-01T00:00:00",
                        "approvals":{}
                      },
                      "results":[]
                    }]
                    """);
            }

            return JsonResponse(
                """
                {
                  "features":[{
                    "geometry":{"coordinates":[-122.5302,48.9242]},
                    "properties":{"StationID":"01F070","StationName":"Test station"}
                  }]
                }
                """);
        });
        var service = new EcologyFlowService(
            factory,
            NullLogger<EcologyFlowService>.Instance);

        var result = await service.GetFlowAsync("01F070", 7, CancellationToken.None);

        Assert.Equal("01F070", result.Station.Id);
        Assert.Empty(result.Observations);
    }

    [Fact]
    public async Task FlowService_ReportsMissingDischargeParameterAsNotFound()
    {
        var factory = new StubHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("<html><body>No discharge parameters</body></html>")
        });
        var service = new EcologyFlowService(
            factory,
            NullLogger<EcologyFlowService>.Instance);

        var exception = await Assert.ThrowsAsync<ExternalDataException>(
            () => service.GetFlowAsync("01N060", 7, CancellationToken.None));

        Assert.Equal(StatusCodes.Status404NotFound, exception.StatusCode);
    }

    [Fact]
    public async Task HydrographyService_ReturnsAndCachesMapboxVectorTile()
    {
        var requests = 0;
        var requestedUrl = string.Empty;
        var halfWorld = 20037508.342789244;
        var span = 2 * halfWorld / (1 << 7);
        var minimumX = -halfWorld + 31 * span;
        var maximumY = halfWorld - 42 * span;
        var centerX = minimumX + span / 2;
        var centerY = maximumY - span / 2;
        var responseBody = JsonSerializer.Serialize(new
        {
            features = new[]
            {
                new
                {
                    geometry = new
                    {
                        type = "LineString",
                        coordinates = new[]
                        {
                            new[] { centerX - span / 4, centerY },
                            new[] { centerX + span / 4, centerY }
                        }
                    },
                    properties = new { gnis_name = "Sample Creek", flowdir = 2, OBJECTID = 1234 }
                }
            }
        });
        var factory = new StubHttpClientFactory(request =>
        {
            requests++;
            requestedUrl = request.RequestUri!.ToString();
            return JsonResponse(responseBody);
        });
        using var cache = new MemoryCache(new MemoryCacheOptions());
        var service = new HydrographyService(
            factory,
            cache,
            NullLogger<HydrographyService>.Instance);

        var tile = await service.GetStreamTileAsync(7, 31, 42, CancellationToken.None);
        var cachedTile = await service.GetStreamTileAsync(7, 31, 42, CancellationToken.None);

        Assert.Equal(1, requests);
        Assert.Contains("outSR=3857", requestedUrl, StringComparison.Ordinal);
        Assert.Contains("resultOffset=0", requestedUrl, StringComparison.Ordinal);
        Assert.Equal(tile, cachedTile);
        Assert.Equal(0x1a, tile[0]);
        var encodedTile = Encoding.UTF8.GetString(tile);
        Assert.Contains("streams", encodedTile, StringComparison.Ordinal);
        Assert.Contains("gnis_name", encodedTile, StringComparison.Ordinal);
        Assert.Contains("name_key", encodedTile, StringComparison.Ordinal);
        Assert.Contains("flowdir", encodedTile, StringComparison.Ordinal);
        Assert.Contains("reach_id", encodedTile, StringComparison.Ordinal);
        Assert.Contains("Sample Creek", encodedTile, StringComparison.Ordinal);
        Assert.Contains("sample creek", encodedTile, StringComparison.Ordinal);
        Assert.True(tile.AsSpan().IndexOf(new byte[] { 0x20, 0xd2, 0x09 }) >= 0);
        Assert.True(tile.AsSpan().IndexOf(new byte[] { 0x20, 0x02 }) >= 0);
    }

    private static HttpResponseMessage JsonResponse(string json) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json")
    };

    private sealed class TestClock : ISystemClock
    {
        public DateTimeOffset UtcNow { get; set; }
    }

    private sealed class StubHttpClientFactory(
        Func<HttpRequestMessage, HttpResponseMessage> respond) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) =>
            new(new StubHttpMessageHandler(respond), disposeHandler: true);
    }

    private sealed class StubHttpMessageHandler(
        Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            Task.FromResult(respond(request));
    }
}
