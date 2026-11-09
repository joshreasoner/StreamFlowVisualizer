using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

namespace StreamFlowVisualizer.Services;

public interface IHydrographyService
{
    Task<byte[]> GetStreamTileAsync(
        int zoom,
        int column,
        int row,
        CancellationToken cancellationToken);
}

public sealed class HydrographyService(
    IHttpClientFactory httpClientFactory,
    IMemoryCache cache,
    ILogger<HydrographyService> logger) : IHydrographyService
{
    private const int TileExtent = 4096;
    private const int MaxFeaturesPerTile = 5000;
    private static readonly TimeSpan CacheDuration = TimeSpan.FromHours(1);

    public async Task<byte[]> GetStreamTileAsync(
        int zoom,
        int column,
        int row,
        CancellationToken cancellationToken)
    {
        var cacheKey = $"hydrography-streams:{zoom}/{column}/{row}";
        if (cache.TryGetValue(cacheKey, out byte[]? cachedTile))
        {
            return cachedTile!;
        }

        try
        {
            var tileBounds = GetTileBounds(zoom, column, row);
            var features = await FetchFeaturesWithRetryAsync(tileBounds, zoom, cancellationToken);
            var tile = EncodeTile(features);
            cache.Set(cacheKey, tile, CacheDuration);
            return tile;
        }
        catch (ExternalDataException)
        {
            throw;
        }
        catch (HttpRequestException exception)
        {
            logger.LogError(exception, "Could not retrieve stream geometry for tile {Zoom}/{Column}/{Row}.",
                zoom, column, row);
            throw new ExternalDataException(
                "USGS stream geometry is unavailable.",
                StatusCodes.Status502BadGateway,
                exception);
        }
        catch (JsonException exception)
        {
            logger.LogError(exception, "USGS stream geometry was not valid GeoJSON.");
            throw new ExternalDataException(
                "USGS stream geometry was returned in an unexpected format.",
                StatusCodes.Status502BadGateway,
                exception);
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogError(exception, "Timed out while retrieving stream geometry.");
            throw new ExternalDataException(
                "USGS stream geometry did not respond in time.",
                StatusCodes.Status504GatewayTimeout,
                exception);
        }
    }

    // The USGS service intermittently times out or returns 5xx; retry transient failures before giving up.
    private async Task<List<TileFeature>> FetchFeaturesWithRetryAsync(
        TileBounds bounds,
        int zoom,
        CancellationToken cancellationToken)
    {
        const int maxAttempts = 3;
        for (var attempt = 1; ; attempt += 1)
        {
            try
            {
                return await FetchFeaturesAsync(bounds, zoom, cancellationToken);
            }
            catch (Exception exception) when (attempt < maxAttempts &&
                !cancellationToken.IsCancellationRequested &&
                (exception is HttpRequestException ||
                    exception is OperationCanceledException))
            {
                logger.LogWarning(exception, "Stream geometry attempt {Attempt} failed; retrying.", attempt);
                await Task.Delay(TimeSpan.FromMilliseconds(400 * attempt), cancellationToken);
            }
        }
    }

    private async Task<List<TileFeature>> FetchFeaturesAsync(
        TileBounds bounds,
        int zoom,
        CancellationToken cancellationToken)
    {
        var features = new List<TileFeature>();
        var client = httpClientFactory.CreateClient("Hydrography");

        for (var offset = 0; offset <= MaxFeaturesPerTile; offset += 1000)
        {
            var pageSize = offset == MaxFeaturesPerTile
                ? 1
                : Math.Min(1000, MaxFeaturesPerTile - offset);
            var geometry = JsonSerializer.Serialize(new
            {
                xmin = bounds.MinX,
                ymin = bounds.MinY,
                xmax = bounds.MaxX,
                ymax = bounds.MaxY,
                spatialReference = new { wkid = 3857 }
            });
            var url = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query" +
                "?where=ftype%3D460" +
                $"&geometry={Uri.EscapeDataString(geometry)}" +
                "&geometryType=esriGeometryEnvelope&inSR=3857&outSR=3857" +
                "&spatialRel=esriSpatialRelIntersects" +
                "&outFields=gnis_name%2Cflowdir%2COBJECTID&returnGeometry=true" +
                $"&resultRecordCount={pageSize}&resultOffset={offset}" +
                "&orderByFields=OBJECTID&f=geojson";

            using var response = await client.GetAsync(url, cancellationToken);
            response.EnsureSuccessStatusCode();
            await using var contentStream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var data = await JsonDocument.ParseAsync(
                contentStream,
                cancellationToken: cancellationToken);

            if (!data.RootElement.TryGetProperty("features", out var page) ||
                page.ValueKind != JsonValueKind.Array)
            {
                logger.LogWarning("The USGS returned an invalid hydrography feature collection.");
                throw new ExternalDataException(
                    "USGS stream geometry was returned in an unexpected format.",
                    StatusCodes.Status502BadGateway);
            }

            if (offset == MaxFeaturesPerTile && page.GetArrayLength() > 0)
            {
                throw new ExternalDataException(
                    "This map tile contains more stream features than the service can return.",
                    StatusCodes.Status502BadGateway);
            }

            foreach (var feature in page.EnumerateArray())
            {
                var lines = ReadLines(feature, bounds, zoom);
                if (lines.Count == 0)
                {
                    continue;
                }

                var name = feature.TryGetProperty("properties", out var properties) &&
                    properties.TryGetProperty("gnis_name", out var nameElement) &&
                    nameElement.ValueKind == JsonValueKind.String
                    ? nameElement.GetString()
                    : null;
                int? flowDirection = properties.ValueKind == JsonValueKind.Object &&
                    properties.TryGetProperty("flowdir", out var directionElement) &&
                    directionElement.ValueKind == JsonValueKind.Number &&
                    directionElement.TryGetInt32(out var direction) &&
                    direction is 1 or 2
                    ? direction
                    : null;
                long? reachId = properties.ValueKind == JsonValueKind.Object &&
                    properties.TryGetProperty("OBJECTID", out var idElement) &&
                    idElement.ValueKind == JsonValueKind.Number &&
                    idElement.TryGetInt64(out var id)
                    ? id
                    : null;
                features.Add(new TileFeature(name, NormalizeReachName(name), flowDirection, reachId, lines));
            }

            if (page.GetArrayLength() < pageSize)
            {
                return features;
            }
        }

        throw new ExternalDataException(
            "This map tile contains more stream features than the service can return.",
            StatusCodes.Status502BadGateway);
    }

    private static List<List<TilePoint>> ReadLines(JsonElement feature, TileBounds bounds, int zoom)
    {
        if (!feature.TryGetProperty("geometry", out var geometry) ||
            !geometry.TryGetProperty("coordinates", out var coordinates))
        {
            return [];
        }

        var lines = new List<List<TilePoint>>();
        if (geometry.TryGetProperty("type", out var type) &&
            type.GetString() == "MultiLineString")
        {
            foreach (var line in coordinates.EnumerateArray())
            {
                AddClippedLine(line, bounds, zoom, lines);
            }
        }
        else if (geometry.TryGetProperty("type", out var lineType) &&
            lineType.GetString() == "LineString")
        {
            AddClippedLine(coordinates, bounds, zoom, lines);
        }

        return lines;
    }

    private static void AddClippedLine(
        JsonElement coordinates,
        TileBounds bounds,
        int zoom,
        List<List<TilePoint>> output)
    {
        var points = new List<TilePoint>();
        foreach (var coordinate in coordinates.EnumerateArray())
        {
            if (coordinate.ValueKind != JsonValueKind.Array ||
                coordinate.GetArrayLength() < 2)
            {
                continue;
            }

            var x = coordinate[0].GetDouble();
            var y = coordinate[1].GetDouble();
            points.Add(new TilePoint(
                (x - bounds.MinX) / (bounds.MaxX - bounds.MinX) * TileExtent,
                (bounds.MaxY - y) / (bounds.MaxY - bounds.MinY) * TileExtent));
        }

        if (points.Count < 2)
        {
            return;
        }

        List<TilePoint>? clippedLine = null;
        var clipBounds = new TileBounds(0, 0, TileExtent, TileExtent);
        for (var index = 1; index < points.Count; index++)
        {
            if (!ClipSegment(points[index - 1], points[index], clipBounds, out var start, out var end))
            {
                if (clippedLine is { Count: > 1 })
                {
                    output.Add(Simplify(clippedLine, zoom));
                }

                clippedLine = null;
                continue;
            }

            if (clippedLine is null || !NearlyEqual(clippedLine[^1], start))
            {
                if (clippedLine is { Count: > 1 })
                {
                    output.Add(Simplify(clippedLine, zoom));
                }

                clippedLine = [start];
            }

            if (!NearlyEqual(clippedLine[^1], end))
            {
                clippedLine.Add(end);
            }
        }

        if (clippedLine is { Count: > 1 })
        {
            output.Add(Simplify(clippedLine, zoom));
        }
    }

    private static bool ClipSegment(
        TilePoint start,
        TilePoint end,
        TileBounds bounds,
        out TilePoint clippedStart,
        out TilePoint clippedEnd)
    {
        var dx = end.X - start.X;
        var dy = end.Y - start.Y;
        var lower = 0d;
        var upper = 1d;
        if (!Clip(-dx, start.X - bounds.MinX, ref lower, ref upper) ||
            !Clip(dx, bounds.MaxX - start.X, ref lower, ref upper) ||
            !Clip(-dy, start.Y - bounds.MinY, ref lower, ref upper) ||
            !Clip(dy, bounds.MaxY - start.Y, ref lower, ref upper))
        {
            clippedStart = default;
            clippedEnd = default;
            return false;
        }

        clippedStart = new TilePoint(start.X + lower * dx, start.Y + lower * dy);
        clippedEnd = new TilePoint(start.X + upper * dx, start.Y + upper * dy);
        return true;
    }

    private static bool Clip(double direction, double distance, ref double lower, ref double upper)
    {
        if (direction == 0)
        {
            return distance >= 0;
        }

        var ratio = distance / direction;
        if (direction < 0)
        {
            if (ratio > upper) return false;
            lower = Math.Max(lower, ratio);
        }
        else
        {
            if (ratio < lower) return false;
            upper = Math.Min(upper, ratio);
        }

        return true;
    }

    private static List<TilePoint> Simplify(List<TilePoint> points, int zoom)
    {
        var tolerance = zoom < 10 ? 3d : zoom < 13 ? 1.5d : 0.5d;
        var keep = new bool[points.Count];
        keep[0] = true;
        keep[^1] = true;
        SimplifySection(points, 0, points.Count - 1, tolerance * tolerance, keep);
        return points.Where((_, index) => keep[index]).ToList();
    }

    private static void SimplifySection(
        IReadOnlyList<TilePoint> points,
        int first,
        int last,
        double toleranceSquared,
        bool[] keep)
    {
        var sections = new Stack<(int First, int Last)>();
        sections.Push((first, last));
        while (sections.TryPop(out var section))
        {
            var maximumDistance = toleranceSquared;
            var selected = -1;
            for (var index = section.First + 1; index < section.Last; index++)
            {
                var distance = DistanceSquaredToSegment(
                    points[index],
                    points[section.First],
                    points[section.Last]);
                if (distance > maximumDistance)
                {
                    maximumDistance = distance;
                    selected = index;
                }
            }

            if (selected < 0)
            {
                continue;
            }

            keep[selected] = true;
            sections.Push((selected, section.Last));
            sections.Push((section.First, selected));
        }
    }

    private static double DistanceSquaredToSegment(TilePoint point, TilePoint start, TilePoint end)
    {
        var dx = end.X - start.X;
        var dy = end.Y - start.Y;
        if (dx == 0 && dy == 0)
        {
            dx = point.X - start.X;
            dy = point.Y - start.Y;
            return dx * dx + dy * dy;
        }

        var position = Math.Clamp(
            ((point.X - start.X) * dx + (point.Y - start.Y) * dy) / (dx * dx + dy * dy),
            0,
            1);
        var differenceX = point.X - (start.X + position * dx);
        var differenceY = point.Y - (start.Y + position * dy);
        return differenceX * differenceX + differenceY * differenceY;
    }

    private static bool NearlyEqual(TilePoint left, TilePoint right) =>
        Math.Abs(left.X - right.X) < 0.01 && Math.Abs(left.Y - right.Y) < 0.01;

    private static TileBounds GetTileBounds(int zoom, int column, int row)
    {
        const double halfWorld = 20037508.342789244;
        var tileCount = Math.Pow(2, zoom);
        var span = 2 * halfWorld / tileCount;
        var minX = -halfWorld + column * span;
        var maxY = halfWorld - row * span;
        return new TileBounds(minX, maxY - span, minX + span, maxY);
    }

    private static byte[] EncodeTile(IReadOnlyList<TileFeature> features)
    {
        using var tile = new MemoryStream();
        using var layer = new MemoryStream();
        WriteStringField(layer, 1, "streams");

        var keys = new[] { "gnis_name", "name_key", "flowdir", "reach_id" };
        var values = new List<TileValue>();
        var valueIndexes = new Dictionary<TileValue, ulong>();

        ulong AddValue(TileValue value)
        {
            if (!valueIndexes.TryGetValue(value, out var valueIndex))
            {
                valueIndex = (ulong)values.Count;
                values.Add(value);
                valueIndexes.Add(value, valueIndex);
            }

            return valueIndex;
        }

        foreach (var key in keys)
        {
            WriteStringField(layer, 3, key);
        }

        foreach (var feature in features)
        {
            using var encodedFeature = new MemoryStream();
            using var tags = new MemoryStream();
            if (!string.IsNullOrWhiteSpace(feature.Name))
            {
                WriteVarint(tags, 0);
                WriteVarint(tags, AddValue(new TileValue(feature.Name, null)));
            }

            if (!string.IsNullOrWhiteSpace(feature.NameKey))
            {
                WriteVarint(tags, 1);
                WriteVarint(tags, AddValue(new TileValue(feature.NameKey, null)));
            }

            if (feature.FlowDirection is { } direction)
            {
                WriteVarint(tags, 2);
                WriteVarint(tags, AddValue(new TileValue(null, direction)));
            }

            if (feature.ReachId is { } reachId)
            {
                WriteVarint(tags, 3);
                WriteVarint(tags, AddValue(new TileValue(null, reachId)));
            }

            if (tags.Length > 0)
            {
                WriteBytesField(encodedFeature, 2, tags.ToArray());
            }

            WriteVarintField(encodedFeature, 3, 2);
            using var geometry = new MemoryStream();
            var cursorX = 0;
            var cursorY = 0;
            foreach (var line in feature.Lines)
            {
                if (line.Count < 2)
                {
                    continue;
                }

                WriteVarint(geometry, (1u << 3) | 1);
                var firstX = (int)Math.Round(line[0].X);
                var firstY = (int)Math.Round(line[0].Y);
                WriteVarint(geometry, ZigZag(firstX - cursorX));
                WriteVarint(geometry, ZigZag(firstY - cursorY));
                cursorX = firstX;
                cursorY = firstY;

                WriteVarint(geometry, ((ulong)(line.Count - 1) << 3) | 2);
                for (var index = 1; index < line.Count; index++)
                {
                    var x = (int)Math.Round(line[index].X);
                    var y = (int)Math.Round(line[index].Y);
                    WriteVarint(geometry, ZigZag(x - cursorX));
                    WriteVarint(geometry, ZigZag(y - cursorY));
                    cursorX = x;
                    cursorY = y;
                }
            }

            WriteBytesField(encodedFeature, 4, geometry.ToArray());
            WriteBytesField(layer, 2, encodedFeature.ToArray());
        }

        foreach (var value in values)
        {
            using var encodedValue = new MemoryStream();
            if (value.Text is { } text)
            {
                WriteStringField(encodedValue, 1, text);
            }
            else if (value.Integer is { } integer)
            {
                WriteVarintField(encodedValue, 4, (ulong)integer);
            }

            WriteBytesField(layer, 4, encodedValue.ToArray());
        }

        WriteVarintField(layer, 5, TileExtent);
        WriteVarintField(layer, 15, 2);
        WriteBytesField(tile, 3, layer.ToArray());
        return tile.ToArray();
    }

    private static void WriteStringField(Stream output, int field, string value) =>
        WriteBytesField(output, field, Encoding.UTF8.GetBytes(value));

    private static void WriteBytesField(Stream output, int field, byte[] value)
    {
        WriteVarint(output, ((ulong)field << 3) | 2);
        WriteVarint(output, (ulong)value.Length);
        output.Write(value);
    }

    private static void WriteVarintField(Stream output, int field, ulong value)
    {
        WriteVarint(output, (ulong)field << 3);
        WriteVarint(output, value);
    }

    private static void WriteVarint(Stream output, ulong value)
    {
        while (value >= 0x80)
        {
            output.WriteByte((byte)((value & 0x7f) | 0x80));
            value >>= 7;
        }

        output.WriteByte((byte)value);
    }

    private static ulong ZigZag(int value) => (ulong)((value << 1) ^ (value >> 31));

    private static string NormalizeReachName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return string.Empty;
        }

        var baseName = Regex.Split(
            name,
            @"\s+(?:nr\.?|near|at|@|above|below)\b",
            RegexOptions.IgnoreCase)[0];
        var expandedName = Regex.Replace(baseName, @"\bcr\.?\b", "creek", RegexOptions.IgnoreCase);
        expandedName = Regex.Replace(expandedName, @"\br\.?\b", "river", RegexOptions.IgnoreCase);
        return Regex.Replace(expandedName.ToLowerInvariant(), @"[^a-z0-9]+", " ").Trim();
    }

    private sealed record TileFeature(
        string? Name,
        string NameKey,
        int? FlowDirection,
        long? ReachId,
        List<List<TilePoint>> Lines);
    private readonly record struct TileValue(string? Text, long? Integer);
    private readonly record struct TilePoint(double X, double Y);
    private readonly record struct TileBounds(double MinX, double MinY, double MaxX, double MaxY);
}
