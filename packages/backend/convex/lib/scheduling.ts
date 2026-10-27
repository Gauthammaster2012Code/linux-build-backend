export interface SchedulableBuild {
  _id: string;
  ownerId: string;
  queuedAt?: number;
  cancelRequestedAt?: number;
}

/**
 * Picks queued builds to start, oldest first, without exceeding the global limit or any owner's limit.
 * `activeByOwner` counts builds that already hold a runner slot.
 */
export function pickBuildsToStart<T extends SchedulableBuild>(
  queued: readonly T[],
  activeByOwner: ReadonlyMap<string, number>,
  activeTotal: number,
  limits: { maxActiveBuildsGlobal: number; maxActiveBuildsPerUser: number },
): T[] {
  let free = limits.maxActiveBuildsGlobal - activeTotal;
  const counts = new Map(activeByOwner);
  const picked: T[] = [];
  const ordered = [...queued].sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
  for (const build of ordered) {
    if (free <= 0) break;
    if (build.cancelRequestedAt) continue;
    const owned = counts.get(build.ownerId) ?? 0;
    if (owned >= limits.maxActiveBuildsPerUser) continue;
    picked.push(build);
    counts.set(build.ownerId, owned + 1);
    free--;
  }
  return picked;
}
