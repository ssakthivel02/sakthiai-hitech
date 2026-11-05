import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../client/src/pages/Creator.tsx', import.meta.url), 'utf8');
const router = readFileSync(new URL('../server/creator/router.ts', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('../server/creator/lifecycle.ts', import.meta.url), 'utf8');
const orchestrator = readFileSync(new URL('../server/creator/orchestrator.ts', import.meta.url), 'utf8');

describe('Creator job result retrieval is explicit, safe and usable', () => {
  it('requires polling to persist a completed provider artifact', () => {
    expect(lifecycle).toContain('providerState === "SUCCEEDED" ? "RUNNING" : providerState');
    expect(orchestrator).toContain('export async function pollCreatorGeneration(');
    expect(orchestrator).toContain('persistCreatorGenerationArtifact');
    expect(router).toContain('pollGeneration: protectedProcedure.input(generationInput).query(');
  });

  it('exposes a manual result check only for in-flight jobs; refresh alone is insufficient', () => {
    expect(page).toContain('utils.creator.pollGeneration.fetch({ workspaceId, generationId })');
    expect(page).toContain('onClick={() => void checkGenerationResult(job.id)}');
    expect(page).toContain('["SUBMITTED", "RUNNING"].includes(job.status)');
    expect(page).toContain('Check result');
    expect(page).toContain('await project.refetch()');
    expect(page).not.toContain('setInterval(() => checkGenerationResult');
    expect(page).not.toContain('refetchInterval: 1000,');
  });

  it('guards concurrent clicks and exposes provider failures without repeating a generation', () => {
    expect(page).toContain('if (!workspaceId || pollingGenerationRef.current) return;');
    expect(page).toContain('pollingGenerationRef.current = true');
    expect(page).toContain('pollingGenerationRef.current = false');
    expect(page).toContain('disabled={pollingGenerationId !== undefined}');
    expect(page).toContain('setPollError(error)');
    expect(page).toContain('panelError, pollError].find(Boolean)');
    expect(page).not.toContain('utils.creator.retryGeneration.fetch');
  });
});
