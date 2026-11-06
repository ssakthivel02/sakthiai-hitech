export type CreatorGenerationIntent = {
  creatorProjectId: number;
  shotId: number | null;
  kind: string;
  provider: string;
  model: string;
  parametersJson: string;
  sourceAssetIdsJson: string | null;
};

export function assertSameGenerationIntent(
  existing: CreatorGenerationIntent,
  incoming: CreatorGenerationIntent,
): void {
  const matches =
    existing.creatorProjectId === incoming.creatorProjectId &&
    existing.shotId === incoming.shotId &&
    existing.kind === incoming.kind &&
    existing.provider === incoming.provider &&
    existing.model === incoming.model &&
    existing.parametersJson === incoming.parametersJson &&
    (existing.sourceAssetIdsJson || "[]") === incoming.sourceAssetIdsJson;

  if (!matches) {
    throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");
  }
}
