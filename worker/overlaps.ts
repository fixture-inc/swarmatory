import type { Overlap, Post } from "../shared/types";

export function canonicalTag(tag: string): string {
  return tag.trim().replace(/^#/, "").trim().toLowerCase();
}
export function sameTag(a: string, b: string): boolean {
  const left = canonicalTag(a);
  return !!left && left === canonicalTag(b);
}
function canonicalPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
}
function normalizedPathsOverlap(left: string, right: string): string | null {
  if (!left || !right) return null;
  if (left === right) return left;
  if (left.startsWith(`${right}/`)) return right;
  if (right.startsWith(`${left}/`)) return left;
  return null;
}
export function pathsOverlap(a: string, b: string): string | null {
  return normalizedPathsOverlap(canonicalPath(a), canonicalPath(b));
}

export const MAX_OVERLAPS = 50;
export const MAX_OVERLAP_WORK = 20_000;

/** A bounded heuristic: truncated means additional conflicts may exist. */
export function findOverlapPage(
  posts: Post[],
  now = Date.now(),
  options: { agentId?: string } = {},
): { overlaps: Overlap[]; truncated: boolean; work: number } {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const latest = new Map<string, Post>();
  for (const post of posts) {
    if (post.parentId || !post.repo || Date.parse(post.createdAt) < cutoff)
      continue;
    const key = `${post.agentId}\u0000${post.repo}`;
    const existing = latest.get(key);
    if (
      !existing ||
      post.createdAt > existing.createdAt ||
      (post.createdAt === existing.createdAt && post.id > existing.id)
    ) {
      latest.set(key, post);
    }
  }

  const scoped = [...latest.values()]
    .filter((post) => post.kind !== "shipped")
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    )
    .map((post) => ({
      post,
      paths: [...new Set(post.paths.map(canonicalPath).filter(Boolean))],
      tags: new Set(post.tags.map(canonicalTag).filter(Boolean)),
    }));
  const overlaps: Overlap[] = [];
  let work = 0;
  // Count pair, path, and tag comparisons so sparse input is bounded too.
  const spend = () => work < MAX_OVERLAP_WORK && ++work;
  for (let i = 0; i < scoped.length; i++) {
    for (let j = i + 1; j < scoped.length; j++) {
      const a = scoped[i];
      const b = scoped[j];
      if (a.post.repo !== b.post.repo) continue;
      // Scope before spending the budget or collecting unrelated matches.
      if (
        options.agentId &&
        a.post.agentId !== options.agentId &&
        b.post.agentId !== options.agentId
      )
        continue;
      if (!spend()) return { overlaps, truncated: true, work };
      const sharedPaths = new Set<string>();
      for (const path of a.paths) {
        for (const other of b.paths) {
          if (!spend()) return { overlaps, truncated: true, work };
          const shared = normalizedPathsOverlap(path, other);
          if (shared) sharedPaths.add(shared);
        }
      }
      const sharedTags: string[] = [];
      for (const tag of a.tags) {
        if (!spend()) return { overlaps, truncated: true, work };
        if (b.tags.has(tag)) sharedTags.push(tag);
      }
      if (sharedPaths.size || sharedTags.length) {
        // Detect an additional match without materializing an unbounded list.
        if (overlaps.length === MAX_OVERLAPS)
          return { overlaps, truncated: true, work };
        overlaps.push({
          agentIds: [a.post.agentId, b.post.agentId],
          postIds: [a.post.id, b.post.id],
          repo: a.post.repo!,
          sharedPaths: [...sharedPaths],
          sharedTags,
        });
      }
    }
  }
  return { overlaps, truncated: false, work };
}

/** Recent roots only; keep the latest post for each agent/repository pair. */
export function findOverlaps(posts: Post[], now = Date.now()): Overlap[] {
  return findOverlapPage(posts, now).overlaps;
}
