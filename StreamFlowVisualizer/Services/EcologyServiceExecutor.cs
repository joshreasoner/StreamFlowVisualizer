using System.Text.Json;

namespace StreamFlowVisualizer.Services;

internal static class EcologyServiceExecutor
{
    public static async Task<HttpResponseMessage> GetResponseAsync(
        HttpClient client,
        string url,
        CancellationToken cancellationToken)
    {
        var response = await client.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();
        return response;
    }

    public static async Task<T> ExecuteAsync<T>(
        ILogger logger,
        string httpFailureTitle,
        string formatFailureTitle,
        string timeoutTitle,
        Func<Task<T>> operation,
        CancellationToken cancellationToken)
    {
        try
        {
            return await operation();
        }
        catch (ExternalDataException)
        {
            throw;
        }
        catch (HttpRequestException exception)
        {
            logger.LogError(exception, "{FailureTitle}", httpFailureTitle);
            throw new ExternalDataException(httpFailureTitle, StatusCodes.Status502BadGateway, exception);
        }
        catch (JsonException exception)
        {
            logger.LogError(exception, "{FailureTitle}", formatFailureTitle);
            throw new ExternalDataException(formatFailureTitle, StatusCodes.Status502BadGateway, exception);
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogError(exception, "{TimeoutTitle}", timeoutTitle);
            throw new ExternalDataException(timeoutTitle, StatusCodes.Status504GatewayTimeout, exception);
        }
    }
}
