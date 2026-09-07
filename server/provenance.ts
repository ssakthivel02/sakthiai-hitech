import { TRPCError } from "@trpc/server";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export type ExtractedSegment = { content: string; page?: number; section?: string; paragraph?: number; sourceStart: number; sourceEnd: number };
export type ExtractedDocument = { text: string; segments: ExtractedSegment[]; pageCount: number };

function segmentText(content: string, start: number, metadata: Omit<ExtractedSegment, "content" | "sourceStart" | "sourceEnd">): ExtractedSegment[] {
  const clean = content.trim();
  if (!clean) return [];
  const result: ExtractedSegment[] = [];
  for (let offset = 0; offset < clean.length; offset += 1200) {
    const chunk = clean.slice(offset, offset + 1200);
    result.push({ content: chunk, sourceStart: start + offset, sourceEnd: start + offset + chunk.length, ...metadata });
  }
  return result;
}

export async function extractDocument(buffer: Buffer, mimeType: string): Promise<ExtractedDocument> {
  if (mimeType === "application/pdf" || mimeType.endsWith("/pdf")) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const pages = result.text.split("\f");
      let cursor = 0;
      const segments = pages.flatMap((pageText: string, index: number) => {
        const page = pageText.trim();
        const start = result.text.indexOf(page, cursor);
        cursor = start >= 0 ? start + page.length : cursor;
        return segmentText(page, Math.max(0, start), { page: index + 1 });
      });
      return { text: result.text.trim(), segments, pageCount: Math.max(1, pages.length) };
    } finally { await parser.destroy(); }
  }
  if (mimeType.includes("wordprocessingml") || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const html = (await mammoth.convertToHtml({ buffer })).value;
    const paragraphMatches: RegExpExecArray[] = [];
    const paragraphPattern = /<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/gi;
    let paragraphMatch: RegExpExecArray | null;
    while ((paragraphMatch = paragraphPattern.exec(html)) !== null) paragraphMatches.push(paragraphMatch);
    const strip = (value: string) => value.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
    let section: string | undefined;
    let cursor = 0;
    const segments: ExtractedSegment[] = [];
    let paragraph = 0;
    for (const match of paragraphMatches) {
      const content = strip(match[2]);
      if (!content) continue;
      if (match[1].toLowerCase().startsWith("h")) section = content;
      else paragraph += 1;
      const start = cursor;
      cursor += content.length + 1;
      segments.push(...segmentText(content, start, { section, paragraph: match[1].toLowerCase() === "p" ? paragraph : undefined }));
    }
    const text = segments.map(segment => segment.content).join("\n\n").trim();
    return { text, segments, pageCount: 1 };
  }
  if (mimeType.startsWith("text/")) {
    const text = buffer.toString("utf8").trim();
    return { text, segments: segmentText(text, 0, {}), pageCount: 1 };
  }
  throw new TRPCError({ code: "BAD_REQUEST", message: "Supported formats: PDF, DOCX, or text files" });
}
