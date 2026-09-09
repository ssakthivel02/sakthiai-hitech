import { googleImageProvider } from "./googleImage";
import { googleVeoProvider } from "./googleVeoAdapter";
import type { CreatorMediaProvider, CreatorMediaRequest } from "./types";

const PROVIDERS: CreatorMediaProvider[] = [googleImageProvider, googleVeoProvider];

export function listCreatorProviderStatuses() {
  return PROVIDERS.map(provider => provider.status());
}

export function getCreatorProvider(providerId: string): CreatorMediaProvider | undefined {
  return PROVIDERS.find(provider => provider.id === providerId);
}

export function selectCreatorProvider(request: CreatorMediaRequest): CreatorMediaProvider {
  const supporting = PROVIDERS.filter(provider => provider.supports(request));
  if (supporting.length === 0) throw new Error(`CREATOR_NO_PROVIDER_SUPPORTS_${request.kind}`);
  const configured = supporting.find(provider => provider.status().configured);
  if (!configured) throw new Error(`CREATOR_PROVIDER_NOT_CONFIGURED_${request.kind}`);
  return configured;
}
