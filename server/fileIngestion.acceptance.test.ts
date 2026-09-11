import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import { extractDocument } from './provenance';

describe('file ingestion extraction acceptance', () => {
  it('extracts UTF-8 text and preserves deterministic source offsets', async () => {
    const input = 'alpha '.repeat(250) + 'omega';
    const result = await extractDocument(Buffer.from(input, 'utf8'), 'text/plain');
    expect(result.text).toBe(input.trim());
    expect(result.pageCount).toBe(1);
    expect(result.segments.length).toBeGreaterThan(1);
    for (const segment of result.segments) {
      expect(segment.content.length).toBeLessThanOrEqual(1200);
      expect(segment.sourceEnd - segment.sourceStart).toBe(segment.content.length);
      expect(segment.sourceStart).toBeGreaterThanOrEqual(0);
      expect(segment.sourceEnd).toBeLessThanOrEqual(result.text.length);
    }
  });

  it('returns no segments for whitespace-only text', async () => {
    const result = await extractDocument(Buffer.from('  \n\t  ', 'utf8'), 'text/plain');
    expect(result.text).toBe('');
    expect(result.segments).toEqual([]);
    expect(result.pageCount).toBe(1);
  });

  it('rejects unsupported MIME types instead of guessing an extractor', async () => {
    await expect(extractDocument(Buffer.from('not an image'), 'image/png')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    } satisfies Partial<TRPCError>);
  });
});
