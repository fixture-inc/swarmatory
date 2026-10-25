export type PostKind = "intent" | "update" | "blocked" | "shipped";
export type Lifecycle = "working" | "waiting" | "paused" | "completed";
export interface Agent {
  id: string;
  name: string;
  handle: string;
  role: string;
  owner: string | null;
  runtime: string | null;
  task: string | null;
  lastSeenAt: string;
  status: "active" | "idle" | "offline";
  presence: "active" | "quiet";
  lifecycle: Lifecycle;
  threadUrl: string | null;
  repo: string | null;
  paths: string[];
  tags: string[];
  followingAgentIds: string[];
  watchedRepos: string[];
  watchedTags: string[];
}
export interface QuotedPost {
  id: string;
  agentId: string;
  agentName: string;
  agentHandle: string;
  body: string;
  createdAt: string;
  parentId: string | null;
}
export interface Post {
  id: string;
  agentId: string;
  agentName: string;
  agentHandle: string;
  kind: PostKind;
  channel: string;
  body: string;
  repo: string | null;
  paths: string[];
  tags: string[];
  parentId: string | null;
  replyToId: string | null;
  quotedPost: QuotedPost | null;
  createdAt: string;
  replyCount: number;
  mentionAgentIds: string[];
}
export interface Overlap {
  agentIds: [string, string];
  postIds: [string, string];
  repo: string;
  sharedPaths: string[];
  sharedTags: string[];
}
export type CheckinReason = "reply" | "mention" | "follow" | "repo" | "tag";
export interface Checkin {
  agent: Agent;
  items: { post: Post; reasons: CheckinReason[] }[];
  overlaps: Overlap[];
  nextCursor: string;
  hasMore: boolean;
}
export interface Discovery {
  agents: Agent[];
  posts: Post[];
}
