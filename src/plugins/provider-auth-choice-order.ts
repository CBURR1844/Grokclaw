const FEATURED_PROVIDER_AUTH_GROUP_ORDER = new Map<string, number>([
  ["anthropic", 0],
  ["openai", 1],
  ["openrouter", 2],
  ["xai", 3],
  ["google", 4],
]);
const providerAuthGroupCollator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Keep native and CLI onboarding on one first-tier provider order. */
export function isFeaturedProviderAuthChoiceGroup(groupId: string): boolean {
  return FEATURED_PROVIDER_AUTH_GROUP_ORDER.has(groupId);
}

export function compareProviderAuthChoiceGroups(
  a: { id: string; label: string },
  b: { id: string; label: string },
): number {
  const priorityA = FEATURED_PROVIDER_AUTH_GROUP_ORDER.get(a.id) ?? Number.POSITIVE_INFINITY;
  const priorityB = FEATURED_PROVIDER_AUTH_GROUP_ORDER.get(b.id) ?? Number.POSITIVE_INFINITY;
  return (
    priorityA - priorityB ||
    providerAuthGroupCollator.compare(a.label, b.label) ||
    providerAuthGroupCollator.compare(a.id, b.id)
  );
}
