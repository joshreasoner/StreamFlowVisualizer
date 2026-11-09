using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ViewFeatures;
using Xunit;
using StreamFlowVisualizer.Controllers;
using StreamFlowVisualizer.Models;
using StreamFlowVisualizer.Services;
using StreamFlowVisualizer.ViewModels;

namespace StreamFlowVisualizer.Tests;

public sealed class HomeControllerTests
{
    [Fact]
    public async Task Index_DefaultsToNooksackAndBertrandCreek()
    {
        var catalog = new FakeEcologyCatalogService();
        var flow = new FakeFlowDataService();
        var controller = CreateController(catalog, flow);

        var result = await controller.Index(null, null, null, CancellationToken.None);

        var model = GetModel(result);
        Assert.Equal("(#01) Nooksack", model.SelectedWriaValue);
        Assert.Equal("01N060", model.SelectedStation?.Id);
        Assert.Equal(7, model.SelectedDays);
        Assert.Equal("Bertrand Creek near mouth", model.StationName);
        Assert.Equal(("01N060", 7), flow.LastRequest);
        Assert.Null(model.ErrorMessage);
    }

    [Fact]
    public async Task Index_RendersBookmarkedWriaStationAndPeriod()
    {
        var flow = new FakeFlowDataService();
        var controller = CreateController(new FakeEcologyCatalogService(), flow);

        var result = await controller.Index(
            "(#03) Lower Skagit-Samish",
            "03C060",
            30,
            CancellationToken.None);

        var model = GetModel(result);
        Assert.Equal("(#03) Lower Skagit-Samish", model.SelectedWriaValue);
        Assert.Equal("Lower Skagit-Samish", model.SelectedWriaName);
        Assert.Equal("03C060", model.SelectedStation?.Id);
        Assert.Equal(30, model.SelectedDays);
        Assert.Equal(("03C060", 30), flow.LastRequest);
        Assert.True(model.HasData);
    }

    [Fact]
    public async Task Index_Accepts365DayPeriod()
    {
        var flow = new FakeFlowDataService();
        var controller = CreateController(new FakeEcologyCatalogService(), flow);

        var result = await controller.Index(null, null, 365, CancellationToken.None);

        var model = GetModel(result);
        Assert.Equal(365, model.SelectedDays);
        Assert.Equal(("01N060", 365), flow.LastRequest);
        Assert.Null(model.ErrorMessage);
    }

    [Fact]
    public async Task ApiParameterHistory_AcceptsLeapWaterYear()
    {
        var flow = new FakeFlowDataService();
        var controller = new ApiController(
            new FakeEcologyCatalogService(), flow, new FakeHydrographyService());
        var start = new DateOnly(2023, 10, 1);
        var end = new DateOnly(2024, 9, 30);

        var result = await controller.GetParameterHistory("01N060", "water-temp-id", start, end, CancellationToken.None);

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(("01N060", "water-temp-id", start, end), flow.LastHistoryRequest);
    }

    [Theory]
    [InlineData("2023-10-01", "2024-10-01")]
    [InlineData("2024-01-02", "2024-01-01")]
    [InlineData("1899-12-31", "1900-01-01")]
    public async Task ApiParameterHistory_RejectsInvalidPeriods(string start, string end)
    {
        var flow = new FakeFlowDataService();
        var controller = new ApiController(
            new FakeEcologyCatalogService(), flow, new FakeHydrographyService());

        var result = await controller.GetParameterHistory(
            "01N060", "water-temp-id", DateOnly.Parse(start), DateOnly.Parse(end), CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Null(flow.LastHistoryRequest);
    }

    [Fact]
    public async Task ApiFlow_Accepts365DayPeriod()
    {
        var flow = new FakeFlowDataService();
        var controller = new ApiController(
            new FakeEcologyCatalogService(),
            flow,
            new FakeHydrographyService());

        var result = await controller.GetFlow(365, "01N060", CancellationToken.None);

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(("01N060", 365), flow.LastRequest);
    }

    [Fact]
    public async Task ApiParameters_ReturnsStationParameters()
    {
        var flow = new FakeFlowDataService();
        var controller = new ApiController(
            new FakeEcologyCatalogService(),
            flow,
            new FakeHydrographyService());

        var result = await controller.GetParameters("01N060", CancellationToken.None);

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal("01N060", flow.LastParameterListStationId);
    }

    [Fact]
    public async Task ApiParameterObservations_ValidatesAndRequestsSelectedParameter()
    {
        var flow = new FakeFlowDataService();
        var controller = new ApiController(
            new FakeEcologyCatalogService(),
            flow,
            new FakeHydrographyService());

        var result = await controller.GetParameterObservations(
            "01N060",
            "water-temp-id",
            30,
            CancellationToken.None);

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(("01N060", "water-temp-id", 30), flow.LastParameterRequest);
    }

    [Fact]
    public async Task ApiParameterObservations_RejectsInvalidPeriod()
    {
        var flow = new FakeFlowDataService();
        var controller = new ApiController(
            new FakeEcologyCatalogService(),
            flow,
            new FakeHydrographyService());

        var result = await controller.GetParameterObservations(
            "01N060",
            "water-temp-id",
            366,
            CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Null(flow.LastParameterRequest);
    }

    [Fact]
    public async Task ApiStreamTile_ReturnsClientClosedStatusWhenRequestIsCanceled()
    {
        using var cancellationSource = new CancellationTokenSource();
        cancellationSource.Cancel();
        var controller = new ApiController(
            new FakeEcologyCatalogService(),
            new FakeFlowDataService(),
            new FakeHydrographyService { CancelRequest = true });

        var result = await controller.GetStreamTile(14, 2618, 5680, cancellationSource.Token);

        Assert.Equal(499, Assert.IsType<StatusCodeResult>(result).StatusCode);
    }

    [Theory]
    [InlineData(14)]
    [InlineData(91)]
    public async Task Index_RejectsUnsupportedPeriodWithoutRequestingFlow(int days)
    {
        var flow = new FakeFlowDataService();
        var controller = CreateController(new FakeEcologyCatalogService(), flow);

        var result = await controller.Index(null, null, days, CancellationToken.None);

        Assert.Equal(StatusCodes.Status400BadRequest, controller.Response.StatusCode);
        Assert.Contains("7, 30, 90, or 365", GetModel(result).ErrorMessage);
        Assert.Null(flow.LastRequest);
    }

    [Fact]
    public async Task Index_RejectsStationNotInSelectedWria()
    {
        var flow = new FakeFlowDataService();
        var controller = CreateController(new FakeEcologyCatalogService(), flow);

        var result = await controller.Index(
            "(#03) Lower Skagit-Samish",
            "999999",
            7,
            CancellationToken.None);

        Assert.Equal(StatusCodes.Status400BadRequest, controller.Response.StatusCode);
        Assert.Contains(
            "station listed in the selected watershed",
            GetModel(result).ErrorMessage,
            StringComparison.OrdinalIgnoreCase);
        Assert.Null(flow.LastRequest);
    }

    [Fact]
    public async Task Index_ReportsFlowServiceFailure()
    {
        var flow = new FakeFlowDataService
        {
            Failure = new ExternalDataException(
                "Washington Ecology did not respond in time.",
                StatusCodes.Status504GatewayTimeout)
        };
        var controller = CreateController(new FakeEcologyCatalogService(), flow);

        var result = await controller.Index(null, null, 7, CancellationToken.None);

        Assert.Equal(StatusCodes.Status504GatewayTimeout, controller.Response.StatusCode);
        Assert.Equal("Washington Ecology did not respond in time.", GetModel(result).ErrorMessage);
    }

    private static HomeController CreateController(
        IEcologyCatalogService catalog,
        IFlowDataService flow)
    {
        var controller = new HomeController(catalog, flow)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext()
            }
        };
        controller.TempData = new TempDataDictionary(
            controller.HttpContext,
            new TestTempDataProvider());
        return controller;
    }

    private static HomeViewModel GetModel(IActionResult result) =>
        Assert.IsType<HomeViewModel>(Assert.IsType<ViewResult>(result).Model);

    private sealed class FakeEcologyCatalogService : IEcologyCatalogService
    {
        public Task<IReadOnlyList<WriaItem>> GetWriasAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<WriaItem>>(
            [
                new WriaItem(1, "(#01) Nooksack", "(#01) Nooksack"),
                new WriaItem(3, "(#03) Lower Skagit-Samish", "(#03) Lower Skagit-Samish")
            ]);

        public Task<IReadOnlyList<StationItem>> GetStationsAsync(
            string wria,
            CancellationToken cancellationToken)
        {
            IReadOnlyList<StationItem> stations = wria == "(#03) Lower Skagit-Samish"
                ? [new StationItem("03C060", "Friday Creek", true, [-122.3282, 48.5584])]
                : [new StationItem("01N060", "Bertrand Creek near mouth", true, [-122.5302, 48.9242])];
            return Task.FromResult(stations);
        }
    }

    private sealed class FakeFlowDataService : IFlowDataService
    {
        public ExternalDataException? Failure { get; init; }

        public (string StationId, int Days)? LastRequest { get; private set; }

        public string? LastParameterListStationId { get; private set; }

        public (string StationId, string ParameterId, int Days)? LastParameterRequest { get; private set; }

        public (string StationId, string ParameterId, DateOnly Start, DateOnly End)? LastHistoryRequest { get; private set; }

        public Task<FlowResponse> GetFlowAsync(
            string stationId,
            int days,
            CancellationToken cancellationToken)
        {
            LastRequest = (stationId, days);
            if (Failure is not null)
            {
                throw Failure;
            }

            var response = new FlowResponse(
                new StationSummary(stationId, stationId == "01N060" ? "Bertrand Creek near mouth" : "Friday Creek",
                    stationId == "01N060" ? [-122.5302, 48.9242] : [-122.3282, 48.5584]),
                "ft^3/s",
                "2026-10-25",
                new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc),
                $"https://example.test/{stationId}",
                [new FlowObservation(new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc), 12.5, "Approved")]);
            return Task.FromResult(response);
        }

        public Task<IReadOnlyList<StationParameter>> GetParametersAsync(
            string stationId,
            CancellationToken cancellationToken)
        {
            LastParameterListStationId = stationId;
            return Task.FromResult<IReadOnlyList<StationParameter>>(
                [new StationParameter("water-temp-id", "Water Temp", true)]);
        }

        public Task<ParameterResponse> GetParameterDataAsync(
            string stationId,
            string parameterId,
            int days,
            CancellationToken cancellationToken)
        {
            LastParameterRequest = (stationId, parameterId, days);
            return Task.FromResult(new ParameterResponse(
                parameterId,
                "Water Temp",
                "degC",
                "2026-10-25",
                $"https://example.test/{stationId}",
                [new FlowObservation(
                    new DateTime(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc),
                    8.7,
                    "Approved")]));
        }

        public Task<ParameterResponse> GetParameterDataAsync(
            string stationId,
            string parameterId,
            DateOnly periodStart,
            DateOnly periodEnd,
            CancellationToken cancellationToken)
        {
            LastHistoryRequest = (stationId, parameterId, periodStart, periodEnd);
            return GetParameterDataAsync(stationId, parameterId, 7, cancellationToken);
        }
    }

    private sealed class FakeHydrographyService : IHydrographyService
    {
        public bool CancelRequest { get; init; }

        public Task<byte[]> GetStreamTileAsync(
            int zoom,
            int column,
            int row,
            CancellationToken cancellationToken) =>
            CancelRequest
                ? Task.FromCanceled<byte[]>(cancellationToken)
                : Task.FromResult(Array.Empty<byte>());
    }

    private sealed class TestTempDataProvider : ITempDataProvider
    {
        public IDictionary<string, object> LoadTempData(HttpContext context) =>
            new Dictionary<string, object>();

        public void SaveTempData(HttpContext context, IDictionary<string, object> values)
        {
        }
    }
}
