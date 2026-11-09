using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using StreamFlowVisualizer.Models;
using StreamFlowVisualizer.Services;
using StreamFlowVisualizer.ViewModels;

namespace StreamFlowVisualizer.Controllers;

public sealed class HomeController(
    IEcologyCatalogService ecologyCatalogService,
    IFlowDataService flowDataService) : Controller
{
    private const string DefaultStationId = "01N060";

    public async Task<IActionResult> Index(
        [FromQuery] string? wria,
        [FromQuery] string? stationId,
        [FromQuery] int? days,
        CancellationToken cancellationToken)
    {
        var model = new HomeViewModel();
        if (!ModelState.IsValid)
        {
            model.ErrorMessage = "Choose a valid observation period.";
            Response.StatusCode = StatusCodes.Status400BadRequest;
        }
        else if (days.HasValue && days.Value is not (7 or 30 or 90 or 365))
        {
            model.ErrorMessage = "Choose an observation period of 7, 30, 90, or 365 days.";
            Response.StatusCode = StatusCodes.Status400BadRequest;
        }
        else if (days.HasValue)
        {
            model.SelectedDays = days.Value;
        }

        try
        {
            model.Wrias = await ecologyCatalogService.GetWriasAsync(cancellationToken);
        }
        catch (ExternalDataException exception)
        {
            SetFailure(model, exception);
            return View(model);
        }

        if (model.Wrias.Count == 0)
        {
            model.ErrorMessage ??= "Washington Ecology did not return any watersheds.";
            Response.StatusCode = StatusCodes.Status502BadGateway;
            return View(model);
        }

        var selectedWria = model.Wrias.FirstOrDefault(item =>
            string.Equals(item.Value, wria, StringComparison.Ordinal));
        if (wria is not null && selectedWria is null)
        {
            model.ErrorMessage ??= "Choose a valid watershed.";
            Response.StatusCode = StatusCodes.Status400BadRequest;
        }

        selectedWria ??= model.Wrias.FirstOrDefault(item => item.Number == 1) ?? model.Wrias[0];
        model.SelectedWriaValue = selectedWria.Value;
        model.SelectedWriaName = Regex.Replace(selectedWria.Name, @"^\(#\d+\)\s*", string.Empty);

        try
        {
            model.Stations = await ecologyCatalogService.GetStationsAsync(
                selectedWria.Value,
                cancellationToken);
        }
        catch (ExternalDataException exception)
        {
            SetFailure(model, exception);
            return View(model);
        }

        if (model.Stations.Count == 0)
        {
            model.ErrorMessage ??= "Ecology lists no streamflow stations in this watershed.";
            return View(model);
        }

        if (!string.IsNullOrEmpty(stationId))
        {
            model.SelectedStation = model.Stations.FirstOrDefault(item =>
                string.Equals(item.Id, stationId, StringComparison.OrdinalIgnoreCase));
            if (model.SelectedStation is null)
            {
                model.ErrorMessage ??= "Choose a station listed in the selected watershed.";
                Response.StatusCode = StatusCodes.Status400BadRequest;
            }
        }

        if (!string.IsNullOrEmpty(stationId) &&
            (stationId.Length is < 1 or > 32 ||
             stationId.Any(character => !char.IsAsciiLetterOrDigit(character))))
        {
            model.ErrorMessage ??= "Choose a valid station.";
            Response.StatusCode = StatusCodes.Status400BadRequest;
        }

        model.SelectedStation ??= model.Stations.FirstOrDefault(item =>
            string.Equals(item.Id, DefaultStationId, StringComparison.OrdinalIgnoreCase));
        model.SelectedStation ??= model.Stations[0];

        if (model.ErrorMessage is not null)
        {
            return View(model);
        }

        try
        {
            model.Flow = await flowDataService.GetFlowAsync(
                model.SelectedStation.Id,
                model.SelectedDays,
                cancellationToken);
        }
        catch (ExternalDataException exception)
        {
            SetFailure(model, exception);
        }

        return View(model);
    }

    private void SetFailure(HomeViewModel model, ExternalDataException exception)
    {
        model.ErrorMessage ??= exception.Title;
        Response.StatusCode = exception.StatusCode;
    }
}
