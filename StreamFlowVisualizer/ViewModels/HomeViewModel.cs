using System.Globalization;
using StreamFlowVisualizer.Models;

namespace StreamFlowVisualizer.ViewModels;

public sealed class HomeViewModel
{
    public string Title { get; } = "Washington Streamflow | Field/Flow";

    public IReadOnlyList<WriaItem> Wrias { get; set; } = [];

    public IReadOnlyList<StationItem> Stations { get; set; } = [];

    public string SelectedWriaValue { get; set; } = "(#01) Nooksack";

    public string SelectedWriaName { get; set; } = "Nooksack";

    public int SelectedDays { get; set; } = 7;

    public StationItem? SelectedStation { get; set; }

    public FlowResponse? Flow { get; set; }

    public string? ErrorMessage { get; set; }

    public bool HasData => Flow?.Observations.Count > 0;

    public string StatusMessage => ErrorMessage is not null
        ? "Data unavailable"
        : HasData ? "Ecology data loaded" : "Waiting for station data";

    public string StationId => SelectedStation?.Id ?? "01N060";

    public string StationName => Flow?.Station.Name ?? SelectedStation?.Name ?? "Select a station";

    public bool IsActive => SelectedStation?.IsActive ?? true;

    public double[]? Coordinates => Flow?.Station.Coordinates ?? SelectedStation?.Coordinates;

    public string CoordinatesText => Coordinates is { Length: >= 2 } coordinates
        ? $"{coordinates[1].ToString("F4", CultureInfo.InvariantCulture)}°N, {Math.Abs(coordinates[0]).ToString("F4", CultureInfo.InvariantCulture)}°W"
        : "Not available";

    public string SourceUrl => Flow?.SourceUrl ??
        $"https://apps.ecology.wa.gov/continuousflowandwq/StationDetails?sta={Uri.EscapeDataString(StationId)}";

    public string FlowValue => LatestObservation?.Value.ToString("0.##", CultureInfo.InvariantCulture) ?? "—";

    public string ChangeIndicator => Flow?.Observations.Count > 1
        ? FormatChange(Flow.Observations[^1].Value - Flow.Observations[^2].Value)
        : "—";

    public bool ChangeIsNegative => Flow?.Observations.Count > 1 &&
        Flow.Observations[^1].Value < Flow.Observations[^2].Value;

    public string PeriodMaximum => Flow?.Observations.Count > 0
        ? Flow.Observations.Max(item => item.Value).ToString("0.#", CultureInfo.InvariantCulture)
        : "—";

    public string PeriodMinimum => Flow?.Observations.Count > 0
        ? Flow.Observations.Min(item => item.Value).ToString("0.#", CultureInfo.InvariantCulture)
        : "—";

    public string ObservationCount => Flow?.Observations.Count.ToString("N0", CultureInfo.InvariantCulture) ?? "—";

    public string LatestRecordText => LatestObservation is { } observation
        ? observation.Date.ToString("MMM dd, HH:mm", CultureInfo.InvariantCulture)
        : "—";

    public string? ChartDescription => HasData
        ? $"Discharge history contains {Flow!.Observations.Count:N0} observations."
        : null;

    public DashboardInitialData InitialData => new(
        SelectedWriaValue,
        SelectedWriaName,
        SelectedStation is null
            ? null
            : SelectedStation with
            {
                Name = StationName,
                Coordinates = Coordinates
            },
        Flow,
        ErrorMessage is not null);

    private FlowObservation? LatestObservation => Flow?.Observations.LastOrDefault();

    private static string FormatChange(double change) =>
        $"{(change > 0 ? "+" : string.Empty)}{change.ToString("0.##", CultureInfo.InvariantCulture)}";
}

public sealed record DashboardInitialData(
    string WriaValue,
    string WriaName,
    StationItem? Station,
    FlowResponse? Flow,
    bool HasError);
