using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using StreamFlowVisualizer.Services;

namespace StreamFlowVisualizer.Controllers;

[ApiController]
[Route("api")]
public sealed partial class ApiController(
    IEcologyCatalogService ecologyCatalogService,
    IFlowDataService flowDataService,
    IHydrographyService hydrographyService) : ControllerBase
{
    private const int ClientClosedRequestStatusCode = 499;

    [HttpGet("wrias")]
    public async Task<IActionResult> GetWrias(CancellationToken cancellationToken)
    {
        try
        {
            return Ok(await ecologyCatalogService.GetWriasAsync(cancellationToken));
        }
        catch (ExternalDataException exception)
        {
            return Problem(title: exception.Title, statusCode: exception.StatusCode);
        }
    }

    [HttpGet("stations")]
    public async Task<IActionResult> GetStations(
        [FromQuery] string? wria,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(wria) ||
            !WriaPattern().IsMatch(wria))
        {
            return BadRequest(new { error = "Choose a valid WRIA." });
        }

        try
        {
            return Ok(await ecologyCatalogService.GetStationsAsync(wria, cancellationToken));
        }
        catch (ExternalDataException exception)
        {
            return Problem(title: exception.Title, statusCode: exception.StatusCode);
        }
    }

    [HttpGet("flow")]
    public async Task<IActionResult> GetFlow(
        [FromQuery] int? days,
        [FromQuery] string? stationId,
        CancellationToken cancellationToken)
    {
        var periodDays = days ?? 7;
        if (periodDays is < 1 or > 365)
        {
            return BadRequest(new { error = "Choose a period between 1 and 365 days." });
        }

        var selectedStationId = stationId ?? "01N060";
        if (selectedStationId.Length is < 1 or > 32 ||
            selectedStationId.Any(character => !char.IsAsciiLetterOrDigit(character)))
        {
            return BadRequest(new { error = "Choose a valid station ID." });
        }

        try
        {
            return Ok(await flowDataService.GetFlowAsync(
                selectedStationId,
                periodDays,
                cancellationToken));
        }
        catch (ExternalDataException exception)
        {
            return Problem(title: exception.Title, statusCode: exception.StatusCode);
        }
    }

    [HttpGet("parameters")]
    public async Task<IActionResult> GetParameters(
        [FromQuery] string? stationId,
        CancellationToken cancellationToken)
    {
        if (!IsValidStationId(stationId))
        {
            return BadRequest(new { error = "Choose a valid station ID." });
        }

        try
        {
            return Ok(await flowDataService.GetParametersAsync(stationId!, cancellationToken));
        }
        catch (ExternalDataException exception)
        {
            return Problem(title: exception.Title, statusCode: exception.StatusCode);
        }
    }

    [HttpGet("parameter-observations")]
    public async Task<IActionResult> GetParameterObservations(
        [FromQuery] string? stationId,
        [FromQuery] string? parameterId,
        [FromQuery] int? days,
        CancellationToken cancellationToken)
    {
        if (!IsValidStationId(stationId))
        {
            return BadRequest(new { error = "Choose a valid station ID." });
        }

        if (string.IsNullOrWhiteSpace(parameterId) ||
            parameterId.Length > 128 ||
            parameterId.Any(char.IsControl))
        {
            return BadRequest(new { error = "Choose a valid station parameter." });
        }

        var periodDays = days ?? 7;
        if (periodDays is < 1 or > 365)
        {
            return BadRequest(new { error = "Choose a period between 1 and 365 days." });
        }

        try
        {
            return Ok(await flowDataService.GetParameterDataAsync(
                stationId!,
                parameterId,
                periodDays,
                cancellationToken));
        }
        catch (ExternalDataException exception)
        {
            return Problem(title: exception.Title, statusCode: exception.StatusCode);
        }
    }

    [HttpGet("parameter-history")]
    public async Task<IActionResult> GetParameterHistory(
        [FromQuery] string? stationId,
        [FromQuery] string? parameterId,
        [FromQuery] DateOnly? start,
        [FromQuery] DateOnly? end,
        CancellationToken cancellationToken)
    {
        if (!IsValidStationId(stationId))
        {
            return BadRequest(new { error = "Choose a valid station ID." });
        }

        if (string.IsNullOrWhiteSpace(parameterId) ||
            parameterId.Length > 128 ||
            parameterId.Any(char.IsControl))
        {
            return BadRequest(new { error = "Choose a valid station parameter." });
        }

        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(
            DateTimeOffset.UtcNow,
            TimeZoneInfo.FindSystemTimeZoneById("America/Los_Angeles")).DateTime);
        if (!start.HasValue || !end.HasValue ||
            start.Value.Year < 1900 || start.Value > end.Value ||
            end.Value.DayNumber - start.Value.DayNumber >= 366 ||
            end.Value > today.AddYears(1))
        {
            return BadRequest(new { error = "Choose a valid historical period of at most 366 days." });
        }

        try
        {
            return Ok(await flowDataService.GetParameterDataAsync(
                stationId!, parameterId, start.Value, end.Value, cancellationToken));
        }
        catch (ExternalDataException exception)
        {
            return Problem(title: exception.Title, statusCode: exception.StatusCode);
        }
    }

    [HttpGet("streams/{zoom:int}/{column:int}/{row:int}.pbf")]
    public async Task<IActionResult> GetStreamTile(
        int zoom,
        int column,
        int row,
        CancellationToken cancellationToken)
    {
        if (zoom is < 7 or > 16)
        {
            return BadRequest(new { error = "Choose a map zoom level between 7 and 16." });
        }

        var tileCount = 1 << zoom;
        if (column < 0 || column >= tileCount || row < 0 || row >= tileCount)
        {
            return BadRequest(new { error = "Choose a valid map tile." });
        }

        try
        {
            var tile = await hydrographyService.GetStreamTileAsync(
                zoom,
                column,
                row,
                cancellationToken);
            Response.Headers.CacheControl = "public, max-age=3600";
            return File(tile, "application/vnd.mapbox-vector-tile");
        }
        catch (ExternalDataException exception)
        {
            return Problem(title: exception.Title, statusCode: exception.StatusCode);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return StatusCode(ClientClosedRequestStatusCode);
        }
    }

    [GeneratedRegex(@"^\(#\d{2}\) [A-Za-z0-9 _.-]+$")]
    private static partial Regex WriaPattern();

    private static bool IsValidStationId(string? stationId) =>
        !string.IsNullOrWhiteSpace(stationId) &&
        stationId.Length <= 32 &&
        stationId.All(char.IsAsciiLetterOrDigit);
}
