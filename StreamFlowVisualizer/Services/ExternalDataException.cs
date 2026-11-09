namespace StreamFlowVisualizer.Services;

public sealed class ExternalDataException(
    string title,
    int statusCode,
    Exception? innerException = null) : Exception(title, innerException)
{
    public string Title { get; } = title;

    public int StatusCode { get; } = statusCode;
}
