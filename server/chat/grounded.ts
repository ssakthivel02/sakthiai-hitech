import type { Citation, searchChunks } from "../db";

export type EvidenceMatches = Awaited<ReturnType<typeof searchChunks>>;

/** Citation projection shared by the synchronous (chat.send) and durable (chat.answer task) paths. */
export const toCitations = (matches: EvidenceMatches): Citation[] =>
  matches.map(match => ({ filename: match.filename, mimeType: match.mimeType, documentId: match.documentId, page: match.page ?? undefined, section: match.section ?? undefined, paragraph: match.paragraph ?? undefined, chunkId: match.id, excerpt: match.content.slice(0, 260), sourceStart: match.sourceStart ?? undefined, sourceEnd: match.sourceEnd ?? undefined, retrievalMethod: match.retrievalMethod, retrievalScore: Number(match.score.toFixed(6)) }));

export const groundedSystemPrompt = (language: "en" | "ta", matches: EvidenceMatches): string => {
  const context = matches.map((m, i) => `[${i + 1}] ${m.filename}${m.page ? ` page ${m.page}` : m.section ? ` section ${m.section}` : ""}: ${m.content}`).join("\n\n");
  return `You are Sakthi AI Nexus. Answer in ${language === "ta" ? "Tamil" : "English"}. Use only the supplied evidence. If it does not support the answer, respond exactly INSUFFICIENT_EVIDENCE. Do not invent citations.\n\nEVIDENCE:\n${context}`;
};
