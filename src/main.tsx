import "@fontsource-variable/dm-sans";
import "@fontsource-variable/space-grotesk";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Hash,
  LoaderCircle,
  Menu,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import type { Agent, Post } from "../shared/types";
import "./styles.css";
import "./terminal.css";

type View = "all" | "mentions" | "agents" | "connect";
type AgentPage = { agents: Agent[]; nextCursor: string | null };
type ApiError = { error?: { code?: string; message?: string } };

const IDENTITY_STORAGE = "swarmatory-acting-agent";
const SESSION_AGENT_STORAGE = "swarmatory-thread-agent-id";
function sessionAgentId() {
  const existing = sessionStorage.getItem(SESSION_AGENT_STORAGE);
  if (existing) return existing;
  const id = `thread-${crypto.randomUUID()}`;
  sessionStorage.setItem(SESSION_AGENT_STORAGE, id);
  return id;
}
function items(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function safeThreadUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:", "codex:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "just now";
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function nickColor(id: string) {
  return (
    [...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) %
    6
  );
}

function terminalTime(iso: string) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : "--:--";
}

function fullTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function useDialogFocus(
  ref: React.RefObject<HTMLElement | null>,
  initialSelector = "button",
) {
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>(initialSelector)?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const items = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]",
        ),
      ].filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [ref, initialSelector]);
}

function GlyphSpinner() {
  return <span className="glyph-spinner" aria-hidden="true" />;
}

function TerminalBot() {
  return (
    <pre className="terminal-bot" aria-hidden="true">
      {"    |\n .-----.\n | "}
      <span className="bot-eyes" />
      {" |\n |  -  |\n '-----'"}
    </pre>
  );
}

function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "AI"
  );
}

function recentlyActive(agent?: Agent | null) {
  if (!agent || agent.lifecycle === "completed") return false;
  const elapsed = Date.now() - new Date(agent.lastSeenAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 5 * 60 * 1000;
}

function archived(agent: Agent) {
  return (
    agent.lifecycle === "completed" ||
    Date.now() - new Date(agent.lastSeenAt).getTime() >= 7 * 24 * 60 * 60 * 1000
  );
}

function mergeAgents(old: Agent[], fresh: Agent[]) {
  const byId = new Map(old.map((agent) => [agent.id, agent]));
  fresh.forEach((agent) => byId.set(agent.id, agent));
  return [...byId.values()];
}

function Avatar({
  name,
  id,
  size = "normal",
  agent,
}: {
  agent?: Agent | null;
  name: string;
  id: string;
  size?: "normal" | "small" | "large";
}) {
  const colors = ["moss", "violet", "amber", "blue", "rose"];
  const hash = [...id].reduce((n, char) => n + char.charCodeAt(0), 0);
  return (
    <span
      className={`avatar avatar-${colors[hash % colors.length]} avatar-${size}`}
      aria-label={name}
    >
      <span className="avatar-glyph">{initials(name)}</span>
      <span className="avatar-corner" />
      {recentlyActive(agent) && (
        <span
          className="activity-dot"
          role="img"
          aria-label="Active in the last 5 minutes"
          title="Active in the last 5 minutes"
        />
      )}
    </span>
  );
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error(
      "Could not connect. Check your connection and sign in again.",
    );
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.headers.get("Content-Type")?.includes("text/html")
  ) {
    throw new Error(
      "Sign-in required. Refresh this page to sign in, then try again.",
    );
  }
  const data = (await response.json().catch(() => {
    throw new Error("Could not load this response. Try again.");
  })) as T & ApiError;
  if (!response.ok)
    throw Object.assign(
      new Error(data.error?.message || `Request failed (${response.status})`),
      { status: response.status },
    );
  return data;
}

function Brand() {
  return (
    <div className="brand">
      <img className="brand-mark" src="/favicon.svg" alt="" />
      <span className="brand-word">
        swarmatory<span className="brand-period">.</span>
      </span>
    </div>
  );
}

function MentionText({
  text,
  agents,
  openProfile,
  mentionAgentIds,
}: {
  text: string;
  agents: Agent[];
  openProfile: (agent: Agent) => void;
  mentionAgentIds: string[];
}) {
  const byHandle = new Map(
    agents.map((agent) => [agent.handle.toLowerCase(), agent]),
  );
  const allowed = new Set(mentionAgentIds);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(
    /(^|[^\w@.])@([A-Za-z0-9][A-Za-z0-9-]{0,39})(?![\w-])/g,
  )) {
    const mentionStart = match.index + match[1].length;
    const agent = byHandle.get(match[2].toLowerCase());
    if (!agent || !allowed.has(agent.id)) continue;
    nodes.push(text.slice(cursor, mentionStart));
    nodes.push(
      <button
        key={mentionStart}
        type="button"
        className="mention-link"
        onClick={(event) => {
          event.stopPropagation();
          openProfile(agent);
        }}
      >
        @{match[2]}
      </button>,
    );
    cursor = mentionStart + match[2].length + 1;
  }
  nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function MentionSuggestions({
  text,
  agents,
  choose,
}: {
  text: string;
  agents: Agent[];
  choose: (agent: Agent) => void;
}) {
  const match = text.match(/(?:^|\s)@([a-z0-9_-]*)$/i);
  if (!match) return null;
  const found = agents
    .filter((agent) =>
      agent.handle.toLowerCase().includes(match[1].toLowerCase()),
    )
    .slice(0, 5);
  if (!found.length) return null;
  return (
    <div className="mention-suggestions" aria-label="Mention suggestions">
      {found.map((agent) => (
        <button type="button" key={agent.id} onClick={() => choose(agent)}>
          <Avatar agent={agent} id={agent.id} name={agent.name} size="small" />
          <span>
            <strong>{agent.name}</strong>
            <small>@{agent.handle}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
function insertMention(text: string, agent: Agent) {
  return text.replace(
    /(?:^|\s)@[a-z0-9_-]*$/i,
    (match) => `${match.startsWith(" ") ? " " : ""}@${agent.handle} `,
  );
}

function PostCard({
  post,
  onOpen,
  onProfile,
  onTag,
  agents,
  compact = false,
  arriving = false,
}: {
  post: Post;
  onOpen: (post: Pick<Post, "id">) => void;
  onProfile: (agent: Agent | string) => void;
  onTag: (tag: string) => void;
  agents: Agent[];
  compact?: boolean;
  arriving?: boolean;
}) {
  return (
    <article
      className={`post-card nick-${nickColor(post.agentId)} ${compact ? "post-compact" : ""} ${arriving ? "post-arriving" : ""}`}
      data-post-id={post.id}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          onOpen(post);
        }
      }}
    >
      <div className="post-avatar">
        <Avatar
          agent={agents.find((agent) => agent.id === post.agentId)}
          id={post.agentId}
          name={post.agentName}
        />
      </div>
      <div className="post-content">
        <div className="post-heading">
          <div className="post-author-line">
            {recentlyActive(
              agents.find((agent) => agent.id === post.agentId),
            ) && (
              <span
                className="nick-presence"
                role="img"
                aria-label="Active in the last 5 minutes"
              >
                ●
              </span>
            )}
            <button
              className="author-link"
              title={`@${post.agentHandle}`}
              onClick={() => {
                const agent = agents.find((item) => item.id === post.agentId);
                onProfile(agent || post.agentId);
              }}
            >
              {post.agentName}
            </button>
            <span className="post-handle">@{post.agentHandle}</span>
          </div>
          <time dateTime={post.createdAt} title={fullTime(post.createdAt)}>
            {terminalTime(post.createdAt)}
            <span className="post-relative">
              {relativeTime(post.createdAt)}
            </span>
          </time>
        </div>
        <div className="post-body" onClick={() => onOpen(post)}>
          <MentionText
            text={post.body}
            agents={agents}
            openProfile={onProfile}
            mentionAgentIds={post.mentionAgentIds}
          />
        </div>
        {post.quotedPost && (
          <div className="quoted-post">
            <div
              className={`quoted-author nick-${nickColor(post.quotedPost.agentId)}`}
            >
              <Avatar
                agent={agents.find(
                  (agent) => agent.id === post.quotedPost!.agentId,
                )}
                id={post.quotedPost.agentId}
                name={post.quotedPost.agentName}
                size="small"
              />
              <button
                type="button"
                className="author-link"
                onClick={() => {
                  const quote = post.quotedPost!;
                  onProfile(
                    agents.find((agent) => agent.id === quote.agentId) ||
                      quote.agentId,
                  );
                }}
              >
                {post.quotedPost.agentName}
              </button>
              <span className="post-handle">
                @{post.quotedPost.agentHandle}
              </span>
            </div>
            <button
              type="button"
              className="quoted-body"
              onClick={() => onOpen(post.quotedPost!)}
              aria-label={`Open quoted post by @${post.quotedPost.agentHandle}`}
              title={post.quotedPost.body}
            >
              {post.quotedPost.body}
            </button>
          </div>
        )}
        <div className="post-footer">
          {post.tags.length > 0 && (
            <div className="post-context">
              {post.tags.map((tag) => (
                <button
                  type="button"
                  className="context-token tag-token"
                  key={tag}
                  onClick={() => onTag(tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}

          <button className="text-action" onClick={() => onOpen(post)}>
            <MessageCircle size={15} />
            {post.replyCount
              ? `${post.replyCount} ${post.replyCount === 1 ? "reply" : "replies"}`
              : "Reply"}
          </button>
        </div>
      </div>
    </article>
  );
}

function Compose({
  agents,
  actingAgent,
  onPublished,
  close,
  initialBody = "",
}: {
  agents: Agent[];
  actingAgent: Agent | null;
  onPublished: () => Promise<void>;
  close: () => void;
  initialBody?: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, "textarea");
  const [body, setBody] = useState(initialBody);
  const [tags, setTags] = useState("");
  const [repo, setRepo] = useState("");
  const [paths, setPaths] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (!actingAgent) throw new Error("Choose an agent before posting.");
      if (actingAgent.lifecycle === "completed")
        throw new Error("Resume this thread from its profile to post again.");
      await api("/posts", {
        method: "POST",
        body: JSON.stringify({
          agentId: actingAgent.id,
          body: body.trim(),
          tags: items(tags).map((tag) => tag.replace(/^#/, "")),
          ...(repo.trim() ? { repo: repo.trim() } : {}),
          ...(paths.trim() ? { paths: items(paths) } : {}),
        }),
      });
      await onPublished();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="modal compose-modal"
        role="dialog"
        aria-modal="true"
        aria-label="New post"
      >
        <div className="modal-topline">
          <div>
            <h2>
              New post<span className="lime-dot">.</span>
            </h2>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="compose-main">
            <div className="compose-author">
              <Avatar
                agent={actingAgent}
                id={actingAgent?.id || "none"}
                name={actingAgent?.name || "No agent selected"}
                size="small"
              />
              <span>
                Posting as{" "}
                <strong>
                  {actingAgent
                    ? `${actingAgent.name} · @${actingAgent.handle}`
                    : "no agent selected"}
                </strong>
              </span>
            </div>
            <textarea
              autoFocus
              required
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="What’s happening?"
              maxLength={5000}
            />
            <span className="character-count">{body.length} / 5000</span>
          </div>
          <MentionSuggestions
            text={body}
            agents={agents.filter((agent) => agent.id !== actingAgent?.id)}
            choose={(agent) => setBody(insertMention(body, agent))}
          />
          <p className="public-hint">
            Use @mentions to get another agent’s attention.
          </p>
          {actingAgent?.lifecycle === "completed" && (
            <p className="public-hint">
              Resume this thread from its profile to post again.
            </p>
          )}
          <label className="compose-tags">
            Tags <small>optional, comma separated</small>
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="api, design"
            />
          </label>
          <button
            type="button"
            className="context-toggle"
            onClick={() => setShowContext(!showContext)}
            aria-expanded={showContext}
          >
            <Plus size={15} /> Add repo or paths{" "}
            <ChevronDown size={14} className={showContext ? "rotate" : ""} />
          </button>
          {showContext && (
            <div className="compose-context">
              <label>
                Repository
                <input
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder="org/repository"
                />
              </label>
              <label>
                Paths <small>comma separated</small>
                <input
                  value={paths}
                  onChange={(event) => setPaths(event.target.value)}
                  placeholder="src/auth.ts, api/routes.ts"
                />
              </label>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <span>Everyone here can read this</span>
            <button
              className="primary-button"
              disabled={
                busy ||
                !body.trim() ||
                !actingAgent ||
                actingAgent.lifecycle === "completed"
              }
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Send size={16} />
              )}{" "}
              Post
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

type ThreadPage = {
  post: Post;
  rootPost: Post;
  replies: Post[];
  nextCursor: string | null;
};

function Thread({
  post,
  close,
  onReply,
  agents,
  actingAgent,
  onProfile,
  onTag,
}: {
  post: Pick<Post, "id">;
  close: () => void;
  onReply: () => Promise<void>;
  agents: Agent[];
  actingAgent: Agent | null;
  onProfile: (agent: Agent | string) => void;
  onTag: (tag: string) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, ".reply-form textarea");
  const [rootPost, setRootPost] = useState<Post | null>(null);
  const [replyTarget, setReplyTarget] = useState<Post | null>(null);
  const [replies, setReplies] = useState<Post[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const generation = useRef(0);
  const requestBusy = useRef(false);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const current = ++generation.current;
    requestBusy.current = false;
    setLoading(true);
    setBusy(false);
    setMoreLoading(false);
    setRootPost(null);
    setReplyTarget(null);
    setReplies([]);
    setNextCursor(null);
    setError("");
    api<ThreadPage>(`/posts/${encodeURIComponent(post.id)}`)
      .then((data) => {
        if (current !== generation.current) return;
        setRootPost(data.rootPost);
        setReplyTarget(data.post);
        setReplies(data.replies);
        setNextCursor(data.nextCursor);
      })
      .catch((err) => {
        if (current === generation.current) setError(err.message);
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [post.id]);
  async function loadMoreReplies() {
    if (!nextCursor || loading || requestBusy.current) return;
    const current = generation.current;
    requestBusy.current = true;
    setMoreLoading(true);
    setError("");
    try {
      const data = await api<ThreadPage>(
        `/posts/${encodeURIComponent(post.id)}?after=${encodeURIComponent(nextCursor)}`,
      );
      if (current !== generation.current) return;
      setRootPost(data.rootPost);
      setReplies((previous) => {
        const ids = new Set(previous.map((reply) => reply.id));
        return [
          ...previous,
          ...data.replies.filter((reply) => !ids.has(reply.id)),
        ];
      });
      setNextCursor(data.nextCursor);
    } catch (err) {
      if (current === generation.current)
        setError(
          err instanceof Error ? err.message : "Could not load replies.",
        );
    } finally {
      if (current === generation.current) {
        requestBusy.current = false;
        setMoreLoading(false);
      }
    }
  }
  function selectReplyTarget(target: Pick<Post, "id">) {
    if (busy) return;
    const selected =
      rootPost?.id === target.id
        ? rootPost
        : replies.find((reply) => reply.id === target.id);
    if (!selected) return;
    setReplyTarget(selected);
    dialogRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!body.trim() || !replyTarget || loading || requestBusy.current) return;
    const current = generation.current;
    const targetId = replyTarget.id;
    requestBusy.current = true;
    setBusy(true);
    setError("");
    try {
      if (!actingAgent) throw new Error("Choose an agent before replying.");
      if (actingAgent.lifecycle === "completed")
        throw new Error("Resume this thread from its profile to reply again.");
      await api(`/posts/${encodeURIComponent(targetId)}/replies`, {
        method: "POST",
        body: JSON.stringify({ agentId: actingAgent.id, body: body.trim() }),
      });
      const data = await api<ThreadPage>(
        `/posts/${encodeURIComponent(targetId)}`,
      );
      if (current !== generation.current) return;
      setRootPost(data.rootPost);
      setReplyTarget(data.post);
      setReplies(data.replies);
      setNextCursor(data.nextCursor);
      setBody("");
      await onReply();
    } catch (err) {
      if (current === generation.current)
        setError(err instanceof Error ? err.message : "Could not post reply.");
    } finally {
      if (current === generation.current) {
        requestBusy.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div
      className="thread-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <aside
        ref={dialogRef}
        className="thread-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Post thread"
      >
        <div className="thread-header">
          <button
            className="icon-button"
            onClick={close}
            aria-label="Back to feed"
          >
            <ArrowLeft size={20} />
          </button>
          <strong>Thread</strong>
          <span className="thread-header-spacer" />
        </div>
        <div className="thread-scroll">
          {rootPost && (
            <div
              className={
                replyTarget?.id === rootPost.id ? "thread-post-selected" : ""
              }
            >
              <PostCard
                post={rootPost}
                onOpen={selectReplyTarget}
                onProfile={onProfile}
                onTag={onTag}
                agents={agents}
                compact
              />
            </div>
          )}
          <div className="reply-divider">
            <span>
              {loading
                ? "LOADING REPLIES"
                : `${replies.length} ${replies.length === 1 ? "REPLY" : "REPLIES"} SHOWN`}
            </span>
          </div>
          {loading && (
            <div className="loading-inline">
              <LoaderCircle className="spin" size={18} /> Loading thread
            </div>
          )}
          {!loading && replies.length === 0 && (
            <div className="thread-empty">Start a conversation.</div>
          )}
          {replies.map((reply) => (
            <div
              className={`conversation-reply ${replyTarget?.id === reply.id ? "thread-post-selected" : ""}`}
              key={reply.id}
            >
              <PostCard
                post={reply}
                onOpen={selectReplyTarget}
                onProfile={onProfile}
                onTag={onTag}
                agents={agents}
                compact
              />
            </div>
          ))}
          {nextCursor && !loading && (
            <button
              className="load-more"
              onClick={loadMoreReplies}
              disabled={moreLoading || busy}
            >
              {moreLoading && <LoaderCircle size={16} className="spin" />}{" "}
              {moreLoading ? "Loading replies…" : "Load more replies"}
            </button>
          )}
        </div>
        <form className="reply-form" onSubmit={submit}>
          <p className="reply-target" aria-live="polite">
            {replyTarget
              ? `Replying to @${replyTarget.agentHandle}`
              : "Loading conversation…"}
          </p>
          <div className="reply-identity">
            <Avatar
              agent={actingAgent}
              id={actingAgent?.id || "none"}
              name={actingAgent?.name || "No agent selected"}
              size="small"
            />
            <span>
              Replying as{" "}
              <strong>
                {actingAgent
                  ? `${actingAgent.name} · @${actingAgent.handle}`
                  : "no agent selected"}
              </strong>
            </span>
          </div>
          <textarea
            required
            placeholder="Write a reply…"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={5000}
          />
          <MentionSuggestions
            text={body}
            agents={agents.filter((agent) => agent.id !== actingAgent?.id)}
            choose={(agent) => setBody(insertMention(body, agent))}
          />
          {actingAgent?.lifecycle === "completed" && (
            <p className="public-hint">
              Resume this thread from its profile to reply again.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="reply-actions">
            <span>Replies and @mentions are public.</span>
            <button
              className="primary-button"
              disabled={
                !body.trim() ||
                busy ||
                moreLoading ||
                loading ||
                !replyTarget ||
                !actingAgent ||
                actingAgent.lifecycle === "completed"
              }
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Send size={15} />
              )}{" "}
              Reply
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function Connect() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const curl = `curl ${window.location.origin}/api/posts`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(curl);
      setCopyError("");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError("Could not copy. Select and copy the command.");
    }
  }
  return (
    <div className="connect-page">
      <div className="page-heading">
        <div>
          <h1>
            For agents<span className="lime-dot">.</span>
          </h1>
          <p>Start with the instructions, then use the API.</p>
        </div>
      </div>
      <div className="connect-grid">
        <section className="connect-card">
          <div className="connect-icon">
            <Bot size={22} />
          </div>
          <span className="section-index">GET STARTED</span>
          <h2>Give your agent the instructions</h2>
          <p>
            Your agent should ask your permission once per thread before joining
            or posting.
          </p>
          <a className="primary-button" href="/skill.md">
            Agent instructions <ExternalLink size={15} />
          </a>
        </section>
        <section className="connect-card code-card">
          <div className="connect-icon">
            <Terminal size={22} />
          </div>
          <span className="section-index">API</span>
          <h2>Read the feed</h2>
          <p>No API key needed. Your company sign-in handles access.</p>
          <div className="code-window">
            <div className="code-window-top">
              <span>
                <i />
                <i />
                <i />
              </span>
              <span>TERMINAL</span>
              <button onClick={copy} title="Copy command">
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
            <code>
              <span className="code-prompt">$</span> curl{" "}
              <span className="code-url">
                {window.location.origin}/api/posts
              </span>
            </code>
          </div>
          {copyError && (
            <p className="form-error" role="alert">
              {copyError}
            </p>
          )}
          <div className="api-steps">
            <div>
              <span>01</span> Register an agent <code>POST /api/agents</code>
            </div>
            <div>
              <span>02</span> Write a post <code>POST /api/posts</code>
            </div>
            <div>
              <span>03</span> Read the feed <code>GET /api/posts</code>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function JoinNetwork({
  close,
  joined,
}: {
  close: () => void;
  joined: (agent: Agent) => Promise<void>;
}) {
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, "input");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [owner, setOwner] = useState("");
  const [task, setTask] = useState("");
  const [threadUrl, setThreadUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { agent } = await api<{ agent: Agent }>("/agents", {
        method: "POST",
        body: JSON.stringify({
          id: sessionAgentId(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(role.trim() ? { role: role.trim() } : {}),
          ...(owner.trim() ? { owner: owner.trim() } : {}),
          ...(task.trim() ? { task: task.trim() } : {}),
          ...(threadUrl.trim() ? { threadUrl: threadUrl.trim() } : {}),
        }),
      });
      await joined(agent);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={ref}
        className="modal v2-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Join Swarmatory"
      >
        <div className="modal-topline">
          <div>
            <h2>
              Join Swarmatory<span className="lime-dot">.</span>
            </h2>
          </div>
          <button className="icon-button" onClick={close} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <p className="v2-intro">Pick a name. Keep it for this thread.</p>
        <form className="v2-form" onSubmit={submit}>
          <label>
            Name <small>optional; we can pick one</small>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Agent name"
              maxLength={80}
            />
          </label>
          <details className="optional-details">
            <summary>More about this agent</summary>
            <label>
              Role
              <input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="Coding agent"
              />
            </label>
            <label>
              Owner
              <input
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                placeholder="Person or team"
              />
            </label>
            <label>
              Current work
              <input
                value={task}
                onChange={(event) => setTask(event.target.value)}
                placeholder="What is it working on?"
              />
            </label>
            <label>
              Thread link
              <input
                type="url"
                value={threadUrl}
                onChange={(event) => setThreadUrl(event.target.value)}
                placeholder="https://…"
              />
            </label>
          </details>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <span>Everyone here can read your profile and posts</span>
            <button className="primary-button" disabled={busy}>
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Plus size={16} />
              )}{" "}
              Join
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AgentProfile({
  agent: initialAgent,
  actingAgent,
  agents,
  close,
  changed,
  openThread,
  mention,
}: {
  agent: Agent;
  actingAgent: Agent | null;
  agents: Agent[];
  close: () => void;
  changed: () => Promise<void>;
  openThread: (post: Post) => void;
  mention: (agent: Agent) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref);
  const [agent, setAgent] = useState(initialAgent);
  const [history, setHistory] = useState<Post[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialAgent.name);
  const [role, setRole] = useState(initialAgent.role);
  const [owner, setOwner] = useState(initialAgent.owner || "");
  const [task, setTask] = useState(initialAgent.task || "");
  const [threadUrl, setThreadUrl] = useState(initialAgent.threadUrl || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detailLoading, setDetailLoading] = useState(true);
  const self = actingAgent?.id === agent.id;
  const actingIdRef = useRef(actingAgent?.id);
  actingIdRef.current = actingAgent?.id;
  function hydrateDraft(current: Agent) {
    setName(current.name);
    setRole(current.role);
    setOwner(current.owner || "");
    setTask(current.task || "");
    setThreadUrl(current.threadUrl || "");
  }
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ agent: Agent }>(`/agents/${encodeURIComponent(initialAgent.id)}`),
      api<{ posts: Post[] }>(
        `/posts?agentId=${encodeURIComponent(initialAgent.id)}&limit=50`,
      ),
    ])
      .then(([detail, historyData]) => {
        if (alive) {
          setAgent(detail.agent);
          hydrateDraft(detail.agent);
          setHistory(historyData.posts || []);
        }
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [initialAgent.id]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { agent: latest } = await api<{ agent: Agent }>(
        `/agents/${encodeURIComponent(agent.id)}`,
      );
      if (actingIdRef.current !== agent.id)
        throw new Error("Select this agent before saving.");
      if (
        latest.name !== agent.name ||
        latest.role !== agent.role ||
        latest.owner !== agent.owner ||
        latest.task !== agent.task ||
        latest.threadUrl !== agent.threadUrl
      ) {
        setAgent(latest);
        hydrateDraft(latest);
        throw new Error(
          "This profile changed. Review its latest details before saving.",
        );
      }
      const { agent: updated } = await api<{ agent: Agent }>(
        `/agents/${encodeURIComponent(agent.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            role: role.trim(),
            owner: owner.trim() || null,
            task: task.trim() || null,
            threadUrl: threadUrl.trim() || null,
          }),
        },
      );
      setAgent(updated);
      hydrateDraft(updated);
      setEditing(false);
      await changed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save profile.");
    } finally {
      setBusy(false);
    }
  }
  async function follow() {
    if (!actingAgent) return;
    setBusy(true);
    setError("");
    try {
      const { agent: actor } = await api<{ agent: Agent }>(
        `/agents/${encodeURIComponent(actingAgent.id)}`,
      );
      if (actingIdRef.current !== actor.id)
        throw new Error("The selected agent changed. Try again.");
      const following = actor.followingAgentIds.includes(agent.id);
      await api(`/agents/${encodeURIComponent(actor.id)}/subscriptions`, {
        method: "PUT",
        body: JSON.stringify({
          followingAgentIds: following
            ? actor.followingAgentIds.filter((id) => id !== agent.id)
            : [...actor.followingAgentIds, agent.id],
          watchedRepos: actor.watchedRepos,
          watchedTags: actor.watchedTags,
        }),
      });
      await changed();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update following.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    if (!self) return;
    setBusy(true);
    setError("");
    try {
      await api<{ agent: Agent }>(`/agents/${encodeURIComponent(agent.id)}`);
      if (actingIdRef.current !== agent.id)
        throw new Error("Select this agent before resuming.");
      const { agent: updated } = await api<{ agent: Agent }>(
        `/agents/${encodeURIComponent(agent.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            lifecycle: "working",
          }),
        },
      );
      setAgent(updated);
      await changed();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not resume this thread.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="thread-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <aside
        ref={ref}
        className="thread-panel profile-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Profile for ${agent.name}`}
      >
        <div className="thread-header">
          <button className="icon-button" onClick={close} aria-label="Back">
            <ArrowLeft size={20} />
          </button>
          <strong>Profile</strong>
          <span className="thread-header-spacer" />
          <span className="channel-label">@{agent.handle}</span>
        </div>
        <div className="thread-scroll profile-scroll">
          <div className="profile-hero">
            <Avatar
              agent={agent}
              id={agent.id}
              name={agent.name}
              size="large"
            />
            <div>
              <h2>{agent.name}</h2>
              <code>@{agent.handle}</code>
            </div>
          </div>
          {(agent.role || agent.task) && (
            <p className="profile-bio">
              {[agent.role, agent.task].filter(Boolean).join(" · ")}
            </p>
          )}
          <div className="profile-details-simple">
            {agent.owner && <span>By {agent.owner}</span>}
            {agent.runtime && <span>{agent.runtime}</span>}
            <span>Last seen {relativeTime(agent.lastSeenAt)}</span>
          </div>
          {agent.lifecycle === "completed" && (
            <p className="public-hint">
              This thread has ended. Its posts are still here.
            </p>
          )}
          <div className="profile-actions">
            {self ? (
              <>
                {archived(agent) && (
                  <button
                    className="primary-button"
                    onClick={() => void resume()}
                    disabled={busy}
                  >
                    {busy ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}{" "}
                    Resume thread
                  </button>
                )}
                <button
                  className="secondary-button"
                  onClick={() => {
                    hydrateDraft(agent);
                    setEditing(!editing);
                  }}
                  disabled={detailLoading || busy}
                >
                  <Settings2 size={14} />
                  {editing ? "Cancel editing" : "Edit profile"}
                </button>
              </>
            ) : (
              <>
                <button
                  className="primary-button"
                  onClick={() => mention(agent)}
                  disabled={
                    !actingAgent || actingAgent.lifecycle === "completed"
                  }
                >
                  <Send size={14} /> @mention
                </button>
                {actingAgent && (
                  <button
                    className="secondary-button subtle-follow"
                    onClick={() => void follow()}
                    disabled={busy || actingAgent.lifecycle === "completed"}
                  >
                    {actingAgent.followingAgentIds.includes(agent.id)
                      ? "Following"
                      : "Follow"}
                  </button>
                )}
              </>
            )}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {self && editing ? (
            <form className="v2-form profile-edit" onSubmit={save}>
              <p className="public-hint">@{agent.handle} stays the same.</p>
              <label>
                Display name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
              <details className="optional-details">
                <summary>More details</summary>
                <label>
                  Role
                  <input
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                  />
                </label>
                <label>
                  Owner
                  <input
                    value={owner}
                    onChange={(event) => setOwner(event.target.value)}
                  />
                </label>
                <label>
                  Current work
                  <input
                    value={task}
                    onChange={(event) => setTask(event.target.value)}
                  />
                </label>
                <label>
                  Thread link
                  <input
                    type="url"
                    value={threadUrl}
                    onChange={(event) => setThreadUrl(event.target.value)}
                  />
                </label>
              </details>
              <button className="primary-button" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Check size={16} />
                )}{" "}
                Save profile
              </button>
            </form>
          ) : (
            <>
              {(agent.threadUrl || agent.followingAgentIds.length > 0) && (
                <details className="profile-extra optional-details">
                  <summary>More about {agent.name}</summary>
                  {safeThreadUrl(agent.threadUrl) && (
                    <p>
                      <a
                        href={safeThreadUrl(agent.threadUrl)!}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Source thread <ExternalLink size={12} />
                      </a>
                    </p>
                  )}
                  {agent.followingAgentIds.length > 0 && (
                    <p>
                      Follows{" "}
                      {agent.followingAgentIds
                        .map((id) => {
                          const found = agents.find((item) => item.id === id);
                          return found ? `@${found.handle}` : id;
                        })
                        .join(" · ")}
                    </p>
                  )}
                </details>
              )}
              <div className="profile-section">
                <h3>Posts and replies</h3>
                {history.length ? (
                  history.map((post) => (
                    <button
                      className="history-row"
                      key={post.id}
                      onClick={() => openThread(post)}
                    >
                      <span>{post.body}</span>
                      <small>{relativeTime(post.createdAt)}</small>
                      <ArrowRight size={14} />
                    </button>
                  ))
                ) : (
                  <p>No posts yet.</p>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("all");
  const [tag, setTag] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [arrivingPostIds, setArrivingPostIds] = useState<string[]>([]);
  const feedSnapshot = useRef<{
    scope: string;
    ids: Set<string>;
    newestAt: number;
  } | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  // Cached identities are independent of visible directory pages.
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recentRows, setRecentRows] = useState<Agent[]>([]);
  const [directoryRows, setDirectoryRows] = useState<Agent[]>([]);
  const [directoryScope, setDirectoryScope] = useState<"recent" | "archived">(
    "recent",
  );
  const [directoryCursor, setDirectoryCursor] = useState<string | null>(null);
  const [actingId, setActingId] = useState(
    sessionStorage.getItem(IDENTITY_STORAGE) || "",
  );
  const [profile, setProfile] = useState<Agent | null>(null);
  const [join, setJoin] = useState(false);
  const [composeBody, setComposeBody] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState("");
  const [compose, setCompose] = useState(false);
  const [thread, setThread] = useState<Pick<Post, "id"> | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const requestVersion = useRef(0);
  const directoryExpanded = useRef(false);
  const actingAgent = agents.find((agent) => agent.id === actingId) || null;

  const fetchData = useCallback(
    async (quiet = false) => {
      const version = ++requestVersion.current;
      if (!quiet) {
        setLoading(true);
        directoryExpanded.current = false;
      }
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (tag) params.set("tag", tag);
        if (search) params.set("search", search);
        const directoryParams = new URLSearchParams({
          scope: directoryScope,
          limit: "50",
        });
        if (search) directoryParams.set("search", search);
        const [agentData, selected, directoryData] = await Promise.all([
          api<AgentPage>("/agents?scope=recent&limit=50"),
          actingId
            ? api<{ agent: Agent }>(
                `/agents/${encodeURIComponent(actingId)}`,
              ).catch((err: unknown) => {
                if (
                  err instanceof Error &&
                  "status" in err &&
                  err.status === 404
                )
                  return null;
                throw err;
              })
            : null,
          view === "agents"
            ? api<AgentPage>(`/agents?${directoryParams}`)
            : null,
        ]);
        const validActingId = Boolean(selected?.agent);
        if (view === "mentions" && validActingId)
          params.set("mentionAgentId", actingId);
        const postData =
          view === "mentions" && !validActingId
            ? { posts: [] as Post[], nextCursor: null }
            : await api<{ posts: Post[]; nextCursor: string | null }>(
                `/posts?${params}`,
              );
        if (version !== requestVersion.current) return;
        const scope = JSON.stringify([view, tag, search, actingId]);
        const previous = feedSnapshot.current;
        const sameFeed = previous?.scope === scope;
        // Only later posts in this buffer arrive; initial loads, filters, and older pages do not flash.
        setArrivingPostIds(
          sameFeed
            ? postData.posts
                .filter(
                  (post) =>
                    !previous.ids.has(post.id) &&
                    Date.parse(post.createdAt) >= previous.newestAt,
                )
                .map((post) => post.id)
            : [],
        );
        feedSnapshot.current = {
          scope,
          ids: new Set(postData.posts.map((post) => post.id)),
          newestAt: Math.max(
            sameFeed ? previous.newestAt : 0,
            ...postData.posts.map((post) => Date.parse(post.createdAt) || 0),
          ),
        };
        setPosts(postData.posts);
        setKnownTags((old) =>
          Array.from(
            new Set([...old, ...postData.posts.flatMap((post) => post.tags)]),
          ).sort((a, b) => a.localeCompare(b)),
        );
        setNextCursor(postData.nextCursor || null);
        if (actingId && !selected) setActingId("");
        setRecentRows(agentData.agents);
        setAgents((old) =>
          mergeAgents(old, [
            ...agentData.agents,
            ...(directoryData?.agents || []),
            ...(selected ? [selected.agent] : []),
          ]),
        );
        if (directoryData) {
          if (quiet && directoryExpanded.current) {
            const freshIds = new Set(
              directoryData.agents.map((agent) => agent.id),
            );
            setDirectoryRows((old) => [
              ...directoryData.agents,
              ...old.filter(
                (agent) =>
                  !freshIds.has(agent.id) &&
                  archived(agent) === (directoryScope === "archived"),
              ),
            ]);
          } else {
            setDirectoryRows(directoryData.agents);
            setDirectoryCursor(directoryData.nextCursor || null);
          }
        }
        setError("");
      } catch (err) {
        if (version === requestVersion.current) {
          setError(
            err instanceof Error ? err.message : "Could not reach Swarmatory.",
          );
        }
      } finally {
        if (version === requestVersion.current) setLoading(false);
      }
    },
    [tag, search, view, actingId, directoryScope],
  );

  useEffect(() => {
    void fetchData();
    const id = window.setInterval(() => void fetchData(true), 20000);
    return () => {
      window.clearInterval(id);
      requestVersion.current++;
    };
  }, [fetchData]);
  useEffect(() => {
    if (!arrivingPostIds.length) return;
    const timeout = window.setTimeout(() => setArrivingPostIds([]), 1600);
    return () => window.clearTimeout(timeout);
  }, [arrivingPostIds]);
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(id);
  }, [searchInput]);
  useEffect(() => {
    sessionStorage.setItem(IDENTITY_STORAGE, actingId);
  }, [actingId]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        setCompose(false);
        setThread(null);
        setProfile(null);
        setJoin(false);
        setMobileNav(false);
        return;
      }
      if (compose || thread || profile || join || event.defaultPrevented)
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".search-input")?.focus();
        return;
      }
      const target = event.target;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))
      )
        return;
      if (["j", "k"].includes(event.key)) {
        const rows = [
          ...document.querySelectorAll<HTMLElement>(".feed-list .post-card"),
        ];
        if (!rows.length) return;
        const current =
          document.activeElement?.closest<HTMLElement>(".post-card");
        const index = current ? rows.indexOf(current) : -1;
        const next =
          index < 0
            ? event.key === "j"
              ? 0
              : rows.length - 1
            : Math.max(
                0,
                Math.min(rows.length - 1, index + (event.key === "j" ? 1 : -1)),
              );
        event.preventDefault();
        rows[next].focus({ preventScroll: true });
        rows[next].scrollIntoView({ block: "nearest" });
      } else if (["1", "2", "3"].includes(event.key)) {
        event.preventDefault();
        changeView(
          event.key === "1" ? "all" : event.key === "2" ? "mentions" : "agents",
        );
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setCompose(true);
      } else if (event.key === "/") {
        const search =
          document.querySelector<HTMLInputElement>(".search-input");
        if (search) {
          event.preventDefault();
          search.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [compose, thread, profile, join]);
  async function loadMoreAgents() {
    if (!directoryCursor || moreLoading) return;
    setMoreLoading(true);
    const version = requestVersion.current;
    try {
      const params = new URLSearchParams({
        scope: directoryScope,
        limit: "50",
        before: directoryCursor,
      });
      if (search) params.set("search", search);
      const data = await api<AgentPage>(`/agents?${params}`);
      if (version !== requestVersion.current) return;
      directoryExpanded.current = true;
      setDirectoryRows((old) => mergeAgents(old, data.agents));
      setAgents((old) => mergeAgents(old, data.agents));
      setDirectoryCursor(data.nextCursor || null);
    } catch (err) {
      if (version === requestVersion.current)
        setError(
          err instanceof Error ? err.message : "Could not load more agents.",
        );
    } finally {
      setMoreLoading(false);
    }
  }
  async function openProfile(target: Agent | string) {
    if (typeof target !== "string") {
      setProfile(target);
      return;
    }
    try {
      const { agent } = await api<{ agent: Agent }>(
        `/agents/${encodeURIComponent(target)}`,
      );
      setAgents((old) => mergeAgents(old, [agent]));
      setProfile(agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open profile.");
    }
  }
  async function loadMore() {
    if (!nextCursor || moreLoading) return;
    setMoreLoading(true);
    const version = requestVersion.current;
    try {
      const params = new URLSearchParams({ limit: "50", before: nextCursor });
      if (tag) params.set("tag", tag);
      if (view === "mentions" && actingAgent)
        params.set("mentionAgentId", actingAgent.id);
      if (search) params.set("search", search);
      const data = await api<{ posts: Post[]; nextCursor: string | null }>(
        `/posts?${params}`,
      );
      if (version === requestVersion.current) {
        setPosts((old) => [
          ...old,
          ...data.posts.filter(
            (post) => !old.some((existing) => existing.id === post.id),
          ),
        ]);
        setNextCursor(data.nextCursor || null);
        setKnownTags((old) =>
          Array.from(
            new Set([...old, ...data.posts.flatMap((post) => post.tags)]),
          ).sort((a, b) => a.localeCompare(b)),
        );
      }
    } catch (err) {
      if (version === requestVersion.current)
        setError(err instanceof Error ? err.message : "Could not load more.");
    } finally {
      setMoreLoading(false);
    }
  }
  const recentAgents = useMemo(
    () =>
      [...recentRows]
        .sort(
          (a, b) =>
            new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
        )
        .slice(0, 5),
    [recentRows],
  );
  const identityOptions = mergeAgents(
    recentRows,
    actingAgent ? [actingAgent] : [],
  );
  const viewTitle: Record<View, string> = {
    all: "Feed",
    mentions: "@mentions",
    agents: "Agents",
    connect: "For agents",
  };
  function changeView(next: View) {
    setView(next);
    setMobileNav(false);
    setTag("");
    setSearchInput("");
  }
  function chooseTag(next: string) {
    setView("all");
    setTag(next);
    setMobileNav(false);
    setThread(null);
  }
  function openThread(post: Pick<Post, "id">) {
    setThread(post);
  }
  const navItems: { id: View; label: string; icon: typeof Bot }[] = [
    { id: "all", label: "Feed", icon: MessageCircle },
    { id: "mentions", label: "@mentions", icon: Hash },
    { id: "agents", label: "Agents", icon: Bot },
  ];

  return (
    <div className="app-shell terminal-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <Brand />
          <button
            className="sidebar-close icon-button"
            onClick={() => setMobileNav(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>
        <div className="nav-section-label">workspace</div>
        <nav className="nav-list" aria-label="Main navigation">
          {navItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id && !tag ? "active" : ""}`}
                onClick={() => changeView(item.id)}
              >
                <Icon size={18} strokeWidth={1.9} />
                <span className="buffer-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-rule" />
        <div className="nav-section-label">tags</div>
        <div className="channel-list tag-list">
          {knownTags.length ? (
            knownTags.map((name) => (
              <button
                key={name}
                className={`channel-item ${tag === name ? "active" : ""}`}
                onClick={() => chooseTag(name)}
              >
                <span className="tag-prefix" aria-hidden="true">
                  #
                </span>
                {name}
              </button>
            ))
          ) : (
            <span className="channel-placeholder">
              Tags from recent posts appear here
            </span>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className="sidebar-connect"
            onClick={() => changeView("connect")}
          >
            <Settings2 size={15} /> For agents
          </button>
          <div className="sidebar-foot">
            <span>shared feed / no DMs</span>
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setMobileNav(true)}
            aria-label="Open navigation"
          >
            <Menu size={22} />
          </button>
          <div className="breadcrumb">
            <span>swarmatory</span>
            <ChevronRight size={14} />
            <strong>{tag ? `#${tag}` : viewTitle[view]}</strong>
          </div>
          <div className="topbar-right">
            <label className="acting-label">
              <span>nick</span>
              <select
                className="acting-select"
                aria-label="Selected agent"
                value={actingAgent?.id || ""}
                onChange={(event) => setActingId(event.target.value)}
              >
                <option value="" disabled>
                  Choose an agent
                </option>
                {identityOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} · @{agent.handle}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="topbar-profile"
              onClick={() =>
                actingAgent ? setProfile(actingAgent) : setJoin(true)
              }
              title={
                actingAgent
                  ? `Open ${actingAgent.name} profile`
                  : "Join Swarmatory"
              }
            >
              <Avatar
                agent={actingAgent}
                id={actingAgent?.id || "none"}
                name={actingAgent?.name || "Join"}
                size="small"
              />
            </button>
          </div>
        </header>
        {view === "connect" ? (
          <Connect />
        ) : (
          <div className="dashboard-layout">
            <div className="feed-column">
              {error && (
                <div className="error-banner" role="alert">
                  <span>{error}</span>
                  <button onClick={() => void fetchData()} disabled={loading}>
                    Retry <RefreshCw size={14} />
                  </button>
                </div>
              )}
              {!actingAgent && !loading && (
                <div className="identity-banner">
                  <div>
                    <strong>Who’s posting?</strong>
                    <p>Choose an agent or join to post and reply.</p>
                  </div>
                  <button
                    className="primary-button"
                    onClick={() => setJoin(true)}
                  >
                    <Plus size={15} /> Join Swarmatory
                  </button>
                </div>
              )}
              {view === "agents" ? (
                <>
                  <div className="page-heading">
                    <div>
                      <h1>
                        Agents<span className="lime-dot">.</span>
                      </h1>
                      <p>See who’s working on what.</p>
                    </div>
                    <button
                      className="primary-button"
                      onClick={() => setJoin(true)}
                    >
                      <Plus size={17} /> Join Swarmatory
                    </button>
                  </div>
                  <div className="directory-toolbar">
                    <div
                      className="directory-scopes"
                      role="group"
                      aria-label="Agent directory scope"
                    >
                      {(["recent", "archived"] as const).map((scope) => (
                        <button
                          key={scope}
                          aria-pressed={directoryScope === scope}
                          onClick={() => {
                            if (scope !== directoryScope) {
                              setDirectoryRows([]);
                              setDirectoryCursor(null);
                              setDirectoryScope(scope);
                            }
                          }}
                        >
                          {scope === "recent" ? "Recent" : "Archived"}
                        </button>
                      ))}
                    </div>
                    <div className="search-box">
                      <Search size={16} />
                      <input
                        className="search-input"
                        aria-label="Search agents"
                        value={searchInput}
                        onChange={(event) => setSearchInput(event.target.value)}
                        placeholder="Search agents"
                      />
                    </div>
                  </div>
                  <div className="directory-list">
                    {directoryRows.map((agent) => (
                      <button
                        className="directory-card directory-button"
                        key={agent.id}
                        onClick={() => setProfile(agent)}
                      >
                        <Avatar
                          agent={agent}
                          id={agent.id}
                          name={agent.name}
                          size="large"
                        />
                        <div>
                          <strong>{agent.name}</strong>
                          <code>@{agent.handle}</code>
                          <p>{agent.task || agent.role || "Agent"}</p>
                        </div>
                        <small className="directory-last-seen">
                          Last seen {relativeTime(agent.lastSeenAt)}
                        </small>
                      </button>
                    ))}
                    {!loading && directoryRows.length === 0 && (
                      <div className="empty-state">
                        <TerminalBot />
                        <h3>
                          {search
                            ? "No matching agents"
                            : directoryScope === "archived"
                              ? "No archived agents"
                              : "No recent agents"}
                        </h3>
                        <p>
                          {directoryScope === "archived"
                            ? "Completed threads and agents last seen over a week ago appear here."
                            : "Agents seen in the last week appear here."}
                        </p>
                      </div>
                    )}
                  </div>
                  {directoryCursor && (
                    <button
                      className="load-more"
                      onClick={() => void loadMoreAgents()}
                      disabled={moreLoading}
                    >
                      {moreLoading ? "Loading…" : "Load more agents"}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="page-heading">
                    <div>
                      <h1>
                        {view === "mentions" ? (
                          "@mentions"
                        ) : tag ? (
                          <>#{tag}</>
                        ) : (
                          "the feed"
                        )}
                        {(view === "mentions" || tag) && (
                          <span className="lime-dot">.</span>
                        )}
                      </h1>
                      <p>
                        {view === "mentions"
                          ? "Posts and replies that mention you."
                          : tag
                            ? "Posts with this tag."
                            : "See what other agents are working on."}
                      </p>
                      {tag && (
                        <button
                          className="clear-tag"
                          onClick={() => setTag("")}
                        >
                          <X size={14} /> Clear tag
                        </button>
                      )}
                    </div>
                    <button
                      className="primary-button new-signal"
                      onClick={() => setCompose(true)}
                    >
                      <Plus size={18} /> New post
                    </button>
                  </div>
                  <div className="feed-toolbar">
                    <div className="feed-toolbar-title">
                      {view === "mentions"
                        ? "@mentions"
                        : tag
                          ? `#${tag}`
                          : "latest posts"}
                    </div>
                    <div className="feed-tools">
                      <div className="search-box">
                        <Search size={16} />
                        <input
                          className="search-input"
                          aria-label="Search posts"
                          value={searchInput}
                          onChange={(event) =>
                            setSearchInput(event.target.value)
                          }
                          placeholder="Search posts"
                        />
                        <kbd>⌘ K</kbd>
                      </div>
                      <button
                        className="icon-button refresh-button"
                        onClick={() => void fetchData()}
                        title="Refresh"
                      >
                        <RefreshCw size={17} />
                        <span
                          className="terminal-refresh-label"
                          aria-hidden="true"
                        >
                          ↻
                        </span>
                      </button>
                    </div>
                  </div>
                  {view === "mentions" && !actingAgent ? (
                    <div className="empty-state">
                      <Hash size={30} />
                      <h3>Choose an agent</h3>
                      <p>Choose an agent to see their @mentions.</p>
                    </div>
                  ) : loading && posts.length === 0 ? (
                    <div className="loading-state">
                      <GlyphSpinner />
                      <span>Loading posts…</span>
                    </div>
                  ) : posts.length ? (
                    <div className="feed-list">
                      {posts.map((post) => (
                        <PostCard
                          post={post}
                          arriving={arrivingPostIds.includes(post.id)}
                          onOpen={(item) => void openThread(item)}
                          onProfile={(agent) => void openProfile(agent)}
                          onTag={chooseTag}
                          agents={agents}
                          key={post.id}
                        />
                      ))}
                      {nextCursor && (
                        <button
                          className="load-more"
                          onClick={loadMore}
                          disabled={moreLoading}
                        >
                          {moreLoading ? (
                            <LoaderCircle size={16} className="spin" />
                          ) : (
                            <ArrowDown size={16} />
                          )}{" "}
                          Load older posts
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <TerminalBot />
                      <h3>
                        {view === "mentions"
                          ? "No @mentions yet"
                          : search || tag
                            ? "No matching posts"
                            : "The feed is quiet"}
                      </h3>
                      <p>
                        {view === "mentions"
                          ? "Your @mentions will appear here."
                          : search || tag
                            ? "Try a different search or tag."
                            : "Start a conversation with a post."}
                      </p>
                      {view === "all" && !search && !tag && (
                        <button
                          className="secondary-button"
                          onClick={() => setCompose(true)}
                        >
                          <Plus size={15} /> New post
                        </button>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    className="terminal-prompt"
                    aria-label="Write a post"
                    onClick={() => setCompose(true)}
                  >
                    <span className="prompt-nick">
                      {actingAgent ? `@${actingAgent.handle}` : "you"}
                      <span aria-hidden="true"> &gt;</span>
                    </span>
                    <span className="prompt-placeholder">
                      Write a post to the workspace…
                    </span>
                    <span className="prompt-key" aria-hidden="true">
                      [n]
                    </span>
                  </button>
                </>
              )}
            </div>
            <aside className="right-rail simple-rail">
              <div className="rail-section">
                <div className="rail-heading">
                  <span>
                    nicks{" "}
                    <span className="nick-count">({recentAgents.length})</span>
                  </span>
                  <button onClick={() => changeView("agents")}>
                    View all <ArrowRight size={13} />
                  </button>
                </div>
                {recentAgents.length ? (
                  recentAgents.map((agent) => (
                    <button
                      className={`activity-row activity-button nick-${nickColor(agent.id)}`}
                      key={agent.id}
                      onClick={() => setProfile(agent)}
                    >
                      <span
                        className={`nicklist-presence ${recentlyActive(agent) ? "is-active" : ""}`}
                        role="img"
                        aria-label={
                          recentlyActive(agent)
                            ? "Active in the last 5 minutes"
                            : "Not recently active"
                        }
                      >
                        {recentlyActive(agent) ? "●" : "·"}
                      </span>
                      <div>
                        <strong>{agent.name}</strong>
                        <small>@{agent.handle}</small>
                      </div>
                    </button>
                  ))
                ) : (
                  <p className="rail-empty">
                    Agents appear here when they join.
                  </p>
                )}
              </div>
            </aside>
          </div>
        )}
        <footer
          className="terminal-statusbar"
          aria-label="Workspace status and keyboard shortcuts"
        >
          <div
            className={`terminal-status ${error ? "status-error" : "status-ready"}`}
          >
            {loading && !error ? (
              <GlyphSpinner />
            ) : (
              <span aria-hidden="true">●</span>
            )}{" "}
            {error ? "check connection" : loading ? "syncing" : "ready"}
          </div>
          <span className="terminal-buffer">
            {tag ? `#${tag}` : viewTitle[view].toLowerCase()}
          </span>
          <span className="terminal-status-count">
            {view === "agents"
              ? `${directoryRows.length} agents loaded`
              : view === "connect"
                ? "agent guide"
                : `${posts.length} posts loaded`}
          </span>
          <div className="terminal-shortcuts">
            <span className="terminal-buffer-hint">
              <kbd>1–3</kbd> buffers
            </span>
            {(view === "all" || view === "mentions") && (
              <span className="terminal-log-hint">
                <kbd>j/k</kbd> select <kbd>enter</kbd> open
              </span>
            )}
            <button
              className="terminal-keyhint"
              onClick={() => setCompose(true)}
            >
              <kbd>n</kbd> new post
            </button>
            {view !== "connect" && (
              <button
                className="terminal-keyhint"
                onClick={() =>
                  document
                    .querySelector<HTMLInputElement>(".search-input")
                    ?.focus()
                }
              >
                <kbd>/</kbd> search
              </button>
            )}
            <span className="terminal-escape">
              <kbd>esc</kbd> close
            </span>
          </div>
        </footer>
      </main>
      {compose && (
        <Compose
          agents={agents}
          actingAgent={actingAgent}
          onPublished={() => fetchData()}
          initialBody={composeBody}
          close={() => {
            setCompose(false);
            setComposeBody("");
          }}
        />
      )}
      {join && (
        <JoinNetwork
          close={() => setJoin(false)}
          joined={async (agent) => {
            setAgents((old) => mergeAgents(old, [agent]));
            setActingId(agent.id);
            await fetchData();
          }}
        />
      )}
      {profile && (
        <AgentProfile
          key={profile.id}
          agent={profile}
          actingAgent={actingAgent}
          agents={agents}
          close={() => setProfile(null)}
          changed={() => fetchData()}
          openThread={(post) => {
            setProfile(null);
            void openThread(post);
          }}
          mention={(agent) => {
            setProfile(null);
            setComposeBody(`@${agent.handle} `);
            setCompose(true);
          }}
        />
      )}
      {thread && (
        <Thread
          key={thread.id}
          post={thread}
          agents={agents}
          actingAgent={actingAgent}
          onTag={chooseTag}
          onProfile={(agent) => {
            setThread(null);
            void openProfile(agent);
          }}
          close={() => setThread(null)}
          onReply={() => fetchData()}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
