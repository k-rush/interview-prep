using System.IO.Compression;
using System.Net;
using System.Text;
using System.Xml.Linq;

namespace InterviewPrep;

internal static class DiscoveryExport
{
    public static IResult Download(string resume, string letter, string? format)
    {
        if (format is null or "txt") return Results.File(Encoding.UTF8.GetBytes($"RESUME\n{resume}\n\nCOVER LETTER\n{letter}\n"),
            "text/plain; charset=utf-8", "reviewed-application-pair.txt");
        if (format == "print")
        {
            static string Paragraphs(string v) => string.Concat(v.ReplaceLineEndings("\n").Split("\n\n")
                .Select(p => "<p>" + WebUtility.HtmlEncode(p).Replace("\n", "<br>") + "</p>"));
            return Results.Content("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Reviewed application pair</title>" +
                "<main><h1>Resume</h1>" + Paragraphs(resume) + "<h1>Cover letter</h1>" + Paragraphs(letter) + "</main></html>",
                "text/html; charset=utf-8");
        }
        if (format != "docx") return Results.BadRequest("Choose txt, docx or print.");
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, true))
        {
            void Write(string name, XElement root)
            {
                using var output = zip.CreateEntry(name).Open();
                root.Save(output);
            }
            XNamespace types = "http://schemas.openxmlformats.org/package/2006/content-types",
                rel = "http://schemas.openxmlformats.org/package/2006/relationships",
                w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
            Write("[Content_Types].xml", new(types + "Types",
                new XElement(types + "Default", new XAttribute("Extension", "rels"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
                new XElement(types + "Override", new XAttribute("PartName", "/word/document.xml"),
                    new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"))));
            Write("_rels/.rels", new(rel + "Relationships", new XElement(rel + "Relationship", new XAttribute("Id", "rId1"),
                new XAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"),
                new XAttribute("Target", "word/document.xml"))));
            IEnumerable<XElement> Paragraphs(string text) => text.ReplaceLineEndings("\n").Split('\n').Select(line =>
                new XElement(w + "p", new XElement(w + "r", new XElement(w + "t", new XAttribute(XNamespace.Xml + "space", "preserve"),
                    string.Concat(line.EnumerateRunes().Where(r => r.Value >= 32 && r.Value != 0xfffe && r.Value != 0xffff).Select(r => r.ToString()))))));
            Write("word/document.xml", new(w + "document", new XAttribute(XNamespace.Xmlns + "w", w),
                new XElement(w + "body", Paragraphs(resume),
                    new XElement(w + "p", new XElement(w + "r", new XElement(w + "br", new XAttribute(w + "type", "page")))), Paragraphs(letter))));
        }
        return Results.File(stream.ToArray(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "reviewed-application-pair.docx");
    }
}
