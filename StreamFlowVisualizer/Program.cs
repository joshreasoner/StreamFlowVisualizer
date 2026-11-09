using StreamFlowVisualizer.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllersWithViews();
builder.Services.AddMemoryCache();
builder.Services.AddHttpClient("Ecology", client =>
{
    client.Timeout = TimeSpan.FromSeconds(60);
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    client.DefaultRequestHeaders.Referrer =
        new Uri("https://apps.ecology.wa.gov/continuousflowandwq/StationDetails?sta=01N060");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
});
builder.Services.AddHttpClient("Hydrography", client =>
{
    client.Timeout = TimeSpan.FromSeconds(20);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("FieldFlow/1.0");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/geo+json, application/json");
});
builder.Services.AddScoped<IEcologyCatalogService, EcologyCatalogService>();
builder.Services.AddScoped<IFlowDataService, EcologyFlowService>();
builder.Services.AddScoped<IHydrographyService, HydrographyService>();

var app = builder.Build();

// A browser that navigates away aborts its request; treat that as a normal client cancellation, not an error.
app.Use(async (context, next) =>
{
    try
    {
        await next();
    }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
    {
        context.Response.StatusCode = 499;
    }
});

app.UseStaticFiles();
app.UseRouting();
app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

app.Run();
