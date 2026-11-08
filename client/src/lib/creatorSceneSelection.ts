/** Select an existing scene for new shots; never leak a stale selection across projects. */
export function chooseCreatorScene<T extends { id: number }>(
  scenes: readonly T[],
  requestedId: number | null,
): T | undefined {
  return scenes.find(scene => scene.id === requestedId) ?? scenes[scenes.length - 1];
}
