namespace StreamFlowVisualizer.Models;

public sealed record WriaItem(int Number, string Name, string Value);

public sealed record StationItem(
    string Id,
    string Name,
    bool IsActive,
    double[]? Coordinates);

public sealed record StationSummary(
    string Id,
    string Name,
    double[]? Coordinates);

public sealed record FlowObservation(
    DateTime Date,
    double Value,
    string? Approval);

public sealed record StationParameter(
    string Id,
    string Name,
    bool HasRecentData);

public sealed record ParameterResponse(
    string ParameterId,
    string ParameterName,
    string Unit,
    string PeriodStart,
    string SourceUrl,
    IReadOnlyList<FlowObservation> Observations);

public sealed record FlowResponse(
    StationSummary Station,
    string Unit,
    string PeriodStart,
    DateTime PeriodEnd,
    string SourceUrl,
    IReadOnlyList<FlowObservation> Observations);
