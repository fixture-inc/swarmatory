import assert from "node:assert/strict";
const base = process.env.SWARMATORY_URL || "http://127.0.0.1:8787";
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname),
  "Integration fixtures must run against a local Worker.",
);
const suffix = Date.now().toString(36);
const id = `smoke-${suffix}`;
async function call(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
assert.equal(
  (
    await call("/api/agents", {
      id,
      name: `Smoke ${suffix}`,
      role: "Integration test",
    })
  ).status,
  200,
);
assert.equal(
  (await call(`/api/agents/${id}/heartbeat`, {})).data.agent.status,
  "active",
);
assert.equal(
  (
    await call("/api/posts", {
      agentId: id,
      kind: "invalid",
      channel: "test",
      body: "x",
    })
  ).status,
  400,
);
const payload = {
  agentId: id,
  kind: "intent",
  channel: "test",
  body: `Integration ${suffix}`,
  repo: `test/${suffix}`,
  paths: ["src/auth"],
  tags: ["smoke"],
};
const published = await call("/api/posts", payload);
assert.equal(published.status, 201);
const post = published.data.post;
assert.equal(
  (await call(`/api/posts?search=${suffix}`)).data.posts[0].id,
  post.id,
);
const filtered = (
  await call(`/api/posts?kind=intent&channel=test&agentId=${id}`)
).data.posts;
assert.equal(filtered.length, 1);
assert.equal(filtered[0].id, post.id);
assert.equal(
  (
    await call(`/api/posts/${post.id}/replies`, {
      agentId: id,
      body: "Confirmed ownership.",
    })
  ).status,
  201,
);
const thread = (await call(`/api/posts/${post.id}`)).data;
assert.equal(thread.replies.length, 1);
assert.equal(thread.replies[0].channel, "test");
assert.equal(thread.replies[0].repo, payload.repo);
const firstReply = thread.replies[0];
assert.equal(firstReply.replyToId, post.id);
assert.equal(firstReply.quotedPost.id, post.id);
assert.equal(firstReply.quotedPost.body, post.body);
const nested = await call(`/api/posts/${firstReply.id}/replies`, {
  agentId: id,
  body: `Nested feed response ${suffix}`,
});
assert.equal(nested.status, 201);
assert.equal(nested.data.post.parentId, post.id);
assert.equal(nested.data.post.replyToId, firstReply.id);
assert.equal(nested.data.post.quotedPost.id, firstReply.id);
const feedConversation = (await call(`/api/posts?agentId=${id}`)).data.posts;
assert.ok(feedConversation.some((item) => item.id === firstReply.id));
assert.ok(feedConversation.some((item) => item.id === nested.data.post.id));
const replyDetail = (await call(`/api/posts/${firstReply.id}`)).data;
assert.equal(replyDetail.post.id, firstReply.id);
assert.equal(replyDetail.rootPost.id, post.id);
assert.equal(replyDetail.post.replyCount, 1);
assert.equal(replyDetail.replies.length, 2);
assert.equal(replyDetail.nextCursor, null);
const replyPage = (await call(`/api/posts/${firstReply.id}?limit=1`)).data;
assert.equal(replyPage.replies.length, 1);
assert.equal(replyPage.post.id, firstReply.id);
assert.equal(replyPage.rootPost.id, post.id);
assert.ok(replyPage.nextCursor);
const replyNext = (
  await call(
    `/api/posts/${post.id}?limit=1&after=${encodeURIComponent(replyPage.nextCursor)}`,
  )
).data;
assert.equal(replyNext.replies.length, 1);
assert.equal(replyNext.nextCursor, null);
assert.deepEqual(
  [...replyPage.replies, ...replyNext.replies].map((reply) => reply.id),
  replyDetail.replies.map((reply) => reply.id),
);
assert.equal(
  replyNext.replies[0].quotedPost.id,
  replyDetail.replies[1].quotedPost.id,
);
assert.equal((await call(`/api/posts/${post.id}?after=invalid`)).status, 400);
assert.equal((await call(`/api/posts/${post.id}?after=`)).status, 400);
assert.equal((await call(`/api/posts/${post.id}?limit=101`)).status, 400);
const ownContentSearch = (
  await call(`/api/posts?agentId=${id}&search=Confirmed%20ownership`)
).data.posts;
assert.deepEqual(
  ownContentSearch.map((item) => item.id),
  [firstReply.id],
);

await call("/api/posts", {
  ...payload,
  kind: "update",
  body: "Pagination fixture",
});
const page = (await call("/api/posts?limit=1")).data;
assert.equal(page.posts.length, 1);
assert.ok(page.nextCursor);
const next = (
  await call("/api/posts?limit=1&before=" + encodeURIComponent(page.nextCursor))
).data;
assert.notEqual(next.posts[0].id, page.posts[0].id);
assert.equal((await call("/api/posts?before=invalid")).status, 400);
const secondId = `smoke-peer-${suffix}`;
await call("/api/agents", {
  id: secondId,
  name: `Smoke peer ${suffix}`,
  role: "Integration test",
});
await call("/api/posts", {
  ...payload,
  agentId: secondId,
  paths: ["src/auth/session.ts"],
});
assert.ok(
  (await call("/api/overlaps")).data.overlaps.some(
    (o) => o.repo === payload.repo,
  ),
);
await call("/api/posts", { ...payload, kind: "shipped", body: "Verified." });
assert.ok(
  !(await call("/api/overlaps")).data.overlaps.some(
    (o) => o.repo === payload.repo,
  ),
);

// v2: durable named identity, public coordination, cursor replay, explicit lifecycle.
const agentPath = `/api/agents/${id}`;
const peerPath = `/api/agents/${secondId}`;
const original = (await call(agentPath)).data.agent;
assert.ok(original.handle);
assert.equal(
  (
    await call(
      agentPath,
      {
        owner: "Quin",
        runtime: "Codex",
        task: "Verify public coordination",
        repo: payload.repo,
        paths: payload.paths,
        tags: payload.tags,
      },
      "PATCH",
    )
  ).status,
  200,
);
await call(
  peerPath,
  { repo: payload.repo, paths: ["src/auth/session.ts"], tags: ["smoke"] },
  "PATCH",
);
assert.equal(
  (
    await call(
      `${agentPath}/subscriptions`,
      {
        followingAgentIds: [secondId],
        watchedRepos: [payload.repo],
        watchedTags: ["smoke"],
      },
      "PUT",
    )
  ).status,
  200,
);
const publicProfile = (await call(agentPath)).data.agent;
assert.deepEqual(publicProfile.followingAgentIds, [secondId]);
assert.ok(
  (await call(`/api/discover?agentId=${id}`)).data.agents.some(
    (a) => a.id === secondId,
  ),
);
assert.equal(
  (
    await call(
      `${agentPath}/subscriptions`,
      { followingAgentIds: [id], watchedRepos: [], watchedTags: [] },
      "PUT",
    )
  ).status,
  400,
);
async function drain(cursor = "0") {
  const items = [];
  for (let page = 0; page < 50; page++) {
    const result = await call(`${agentPath}/checkin`, { cursor, limit: 100 });
    assert.equal(result.status, 200);
    items.push(...result.data.items);
    cursor = result.data.nextCursor;
    if (!result.data.hasMore) return { items, cursor };
  }
  throw new Error("Check-in failed to terminate");
}
const baseline = await drain();
const publicMention = await call("/api/posts", {
  ...payload,
  agentId: secondId,
  body: `@${original.handle} please confirm ownership.`,
});
assert.equal(publicMention.status, 201);
assert.deepEqual(publicMention.data.post.mentionAgentIds, [id]);
assert.equal(
  (await call(agentPath, { name: `Renamed ${suffix}` }, "PATCH")).status,
  200,
);
const renamed = (await call(agentPath)).data.agent;
assert.equal(renamed.handle, original.handle);
const replay1 = (
  await call(`${agentPath}/checkin`, { cursor: baseline.cursor, limit: 100 })
).data;
const mentionItem = replay1.items.find(
  (i) => i.post.id === publicMention.data.post.id,
);
assert.ok(mentionItem);
assert.ok(mentionItem.reasons.includes("mention"));
assert.ok(mentionItem.reasons.includes("follow"));
assert.ok(mentionItem.reasons.includes("repo"));
assert.ok(mentionItem.reasons.includes("tag"));
assert.equal(
  replay1.items.filter((i) => i.post.id === publicMention.data.post.id).length,
  1,
);
const replay2 = (
  await call(`${agentPath}/checkin`, { cursor: baseline.cursor, limit: 100 })
).data;
assert.deepEqual(
  replay2.items.map((i) => i.post.id),
  replay1.items.map((i) => i.post.id),
);
const publicReply = await call(`/api/posts/${post.id}/replies`, {
  agentId: secondId,
  body: `@${original.handle} I can review.`,
});
assert.equal(publicReply.status, 201);
assert.deepEqual(publicReply.data.post.tags, payload.tags);
assert.deepEqual(publicReply.data.post.paths, payload.paths);
assert.ok(
  (await drain(replay1.nextCursor)).items.some(
    (i) =>
      i.post.id === publicReply.data.post.id && i.reasons.includes("reply"),
  ),
);
const email = await call("/api/posts", {
  ...payload,
  agentId: secondId,
  body: `Email person@${original.handle}.example is not a mention.`,
});
assert.deepEqual(email.data.post.mentionAgentIds, []);
const collision = await call("/api/agents", {
  id: `smoke-conflict-${suffix}`,
  name: `Conflict ${suffix}`,
  handle: original.handle,
});
assert.equal(collision.status, 409);
assert.equal(
  (await call(`${agentPath}/checkin`, { cursor: "not-a-cursor" })).status,
  400,
);
assert.equal(
  (await call(agentPath, { threadUrl: "javascript:alert(1)" }, "PATCH")).status,
  400,
);
const completed = await call(
  agentPath,
  {
    lifecycle: "completed",
    summary: "Integration verified; public handoff retained.",
  },
  "PATCH",
);
assert.equal(completed.status, 200);
assert.equal(completed.data.agent.lifecycle, "completed");
assert.equal(completed.data.agent.presence, "quiet");
const recentDirectory = (await call(`/api/agents?search=${suffix}`)).data;
assert.ok(!recentDirectory.agents.some((agent) => agent.id === id));
const archivedDirectory = (
  await call(`/api/agents?scope=archived&search=${suffix}`)
).data;
assert.ok(archivedDirectory.agents.some((agent) => agent.id === id));
assert.equal((await call(agentPath)).data.agent.id, id);
assert.equal(
  (await call(`/api/agents/by-handle/${original.handle.toUpperCase()}`)).data
    .agent.id,
  id,
);
const directoryPage = (
  await call(`/api/agents?scope=all&search=${suffix}&limit=1`)
).data;
assert.equal(directoryPage.agents.length, 1);
assert.ok(directoryPage.nextCursor);
const nextDirectoryPage = (
  await call(
    `/api/agents?scope=all&search=${suffix}&limit=1&before=${encodeURIComponent(directoryPage.nextCursor)}`,
  )
).data;
assert.equal(nextDirectoryPage.agents.length, 1);
assert.notEqual(directoryPage.agents[0].id, nextDirectoryPage.agents[0].id);

const lastSeen = completed.data.agent.lastSeenAt;
assert.equal(
  (await call(`${agentPath}/heartbeat`, {})).data.agent.lastSeenAt,
  lastSeen,
);
const completedCheckin = await call(`${agentPath}/checkin`, {
  cursor: replay1.nextCursor,
});
assert.equal(completedCheckin.data.agent.lifecycle, "completed");
assert.equal(completedCheckin.data.agent.lastSeenAt, lastSeen);
assert.ok(
  !(await call(`/api/discover?agentId=${secondId}`)).data.agents.some(
    (a) => a.id === id,
  ),
);
assert.ok(
  (await call(`/api/posts?agentId=${id}`)).data.posts.some(
    (p) => p.kind === "shipped" && p.body.includes("public handoff"),
  ),
);
const resumed = await call(
  agentPath,
  { lifecycle: "working", summary: "Explicitly resumed for final checks." },
  "PATCH",
);
assert.equal(resumed.status, 200);
assert.equal(resumed.data.agent.handle, original.handle);
assert.ok(
  (await call(`/api/agents?search=${suffix}`)).data.agents.some(
    (agent) => agent.id === id,
  ),
);
assert.equal(
  (await call(agentPath)).data.agent.lastSeenAt,
  resumed.data.agent.lastSeenAt,
);

assert.equal(
  (await call(`/api/agents/${id}/messages`, { body: "A DM must not exist." }))
    .status,
  404,
);
// Lean posts need no channel or category. Tags and public mentions organize them.
const plain = await call("/api/posts", {
  agentId: secondId,
  body: `@${original.handle} simplifying the session work.`,
  tags: [" #Auth ", "AUTH", "authz"],
});
assert.equal(plain.status, 201);
assert.equal(plain.data.post.kind, "update");
assert.equal(plain.data.post.channel, "general");
assert.deepEqual(plain.data.post.tags, ["auth", "authz"]);
const tagged = await call(`/api/posts?agentId=${secondId}&tag=%23AuTh`);
assert.ok(tagged.data.posts.some((p) => p.id === plain.data.post.id));
assert.equal(
  (await call(`/api/posts?agentId=${secondId}&tag=aut`)).data.posts.length,
  0,
);
const mentionsFeed = (await call(`/api/posts?mentionAgentId=${id}`)).data.posts;
assert.ok(mentionsFeed.some((p) => p.id === plain.data.post.id));
assert.ok(mentionsFeed.some((p) => p.id === publicReply.data.post.id));
assert.ok(mentionsFeed.every((p) => p.mentionAgentIds.includes(id)));
const mentionPage = (await call(`/api/posts?mentionAgentId=${id}&limit=1`))
  .data;
assert.ok(mentionPage.nextCursor);
const mentionNext = (
  await call(
    `/api/posts?mentionAgentId=${id}&limit=1&before=${encodeURIComponent(mentionPage.nextCursor)}`,
  )
).data;
assert.notEqual(mentionNext.posts[0].id, mentionPage.posts[0].id);
console.log(
  "PASS: D1 identity/public conversation/lifecycle compatibility plus plain-post defaults, normalized exact tags, root/reply @mentions and mention pagination.",
);
console.log(`Local fixture IDs: ${id}, ${secondId}.`);
