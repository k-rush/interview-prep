using System.Collections.Frozen;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace InterviewPrep;

// Each request gets one immutable snapshot, including requests that call the model more than once.
public sealed class PromptPack
{
    internal const int Contract = 1;
    internal const int MaxBytes = 128 * 1024;
    private readonly FrozenDictionary<string, string> texts;
    public string Version { get; }
    public string Digest { get; }
    internal string this[string id] => texts[id];

    private PromptPack(string version, Dictionary<string, string> prompts)
    {
        if (!Regex.IsMatch(version, @"\A(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\z"))
            throw new InvalidDataException("Invalid prompt pack version.");
        Version = version;
        var framed = new StringBuilder("interview-prep-prompts/1\0").Append(version).Append('\0');
        foreach (var id in prompts.Keys.Order(StringComparer.Ordinal).ToArray())
        {
            var text = prompts[id].Replace("\r\n", "\n").TrimEnd('\n');
            if (string.IsNullOrWhiteSpace(text) || text.Length > 8192 || text.Any(c => char.IsControl(c) && c is not '\n' and not '\t'))
                throw new InvalidDataException("Invalid instruction text.");
            prompts[id] = text;
            framed.Append(id).Append('\0').Append(text).Append('\0');
        }
        texts = prompts.ToFrozenDictionary(StringComparer.Ordinal);
        Digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(framed.ToString())));
    }

    private static readonly Lazy<PromptPack> Default = new(() =>
    {
        static string Read(string name)
        {
            using var stream = typeof(PromptPack).Assembly.GetManifestResourceStream("CoachPrompts." + name)
                ?? throw new InvalidDataException("Bundled prompt resource missing: " + name);
            using var reader = new StreamReader(stream);
            return reader.ReadToEnd();
        }
        using var release = JsonDocument.Parse(Read("release.json"));
        var root = release.RootElement;
        if (root.GetProperty("contract").GetInt32() != Contract) throw new InvalidDataException("Unsupported bundled prompt contract.");
        var texts = root.GetProperty("ids").EnumerateArray().Select(id => id.GetString()!)
            .ToDictionary(id => id, id => Read(id + ".txt"), StringComparer.Ordinal);
        return new(root.GetProperty("version").GetString()!, texts);
    });
    internal static PromptPack Bundled => Default.Value;

    internal static PromptPack Decode(byte[] bytes)
    {
        using var json = JsonDocument.Parse(bytes);
        var root = json.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 3 ||
            root.GetProperty("contract").GetInt32() != Contract ||
            root.GetProperty("version").GetString() is not string version ||
            root.GetProperty("prompts").ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Unsupported prompt pack.");
        var all = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var prop in root.GetProperty("prompts").EnumerateObject())
            if (!Bundled.texts.ContainsKey(prop.Name) || prop.Value.GetString() is not string text || !all.TryAdd(prop.Name, text))
                throw new InvalidDataException("Unexpected prompt contract.");
        if (all.Count != Bundled.texts.Count) throw new InvalidDataException("Missing required prompt.");
        return new(version, all);
    }
}

internal sealed class PromptCatalog(string? store, ILogger<PromptCatalog> log)
{
    private readonly object gate = new();
    private PromptPack current = PromptPack.Bundled;
    private bool warned;

    private static byte[] Read(string path, int max)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        if (file.Length > max) throw new InvalidDataException("Oversized prompt artifact.");
        var bytes = new byte[(int)file.Length];
        file.ReadExactly(bytes);
        return bytes;
    }

    internal PromptPack Snapshot()
    {
        if (store is null) return current;
        lock (gate)
        {
            try
            {
                var digest = Encoding.ASCII.GetString(Read(Path.Combine(store, "active"), 66)).TrimEnd('\r', '\n');
                if (!Regex.IsMatch(digest, @"\A[0-9a-f]{64}\z")) throw new InvalidDataException("Invalid prompt pointer.");
                if (digest != current.Digest)
                {
                    var pack = PromptPack.Decode(Read(Path.Combine(store, "releases", digest + ".json"), PromptPack.MaxBytes));
                    if (pack.Digest != digest) throw new InvalidDataException("Prompt digest mismatch.");
                    current = pack;
                    log.LogInformation("Serving prompt pack {Version} {Digest}", pack.Version, pack.Digest);
                }
                warned = false;
            }
            catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or JsonException or
                KeyNotFoundException or InvalidOperationException or FormatException or ArgumentException)
            {
                if (!warned) log.LogWarning("Cannot activate prompt pack; continuing to serve {Version} {Digest}", current.Version, current.Digest);
                warned = true;
            }
            return current;
        }
    }
}
