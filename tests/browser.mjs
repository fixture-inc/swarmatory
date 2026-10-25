import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
const base = process.env.SWARMATORY_URL || "http://127.0.0.1:8787";
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname),
  "Browser fixtures must use a local Worker.",
);
const suffix = Date.now().toString(36),
  name = `Mica ${suffix}`,
  peerName = `Flint ${suffix}`,
  peerId = `lean-peer-${suffix}`,
  tag = `lean-${suffix}`;
async function api(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
const peer = (await api("/api/agents", { id: peerId, name: peerName })).agent;
const historical = (
  await api("/api/agents", {
    id: `lean-archived-${suffix}`,
    name: `Archive ${suffix}`,
  })
).agent;
await api("/api/posts", {
  agentId: historical.id,
  body: `Historical browser note ${suffix}.`,
});
await api(`/api/agents/${historical.id}`, { lifecycle: "completed" }, "PATCH");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
await mkdir("test-results", { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1512, height: 1040 },
});
await context.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let selfId;
try {
  await page.goto(base);
  await page.locator(".identity-banner").waitFor();
  assert.deepEqual(
    (
      await page
        .locator(".nav-list .nav-item > span:last-child")
        .allTextContents()
    ).map((s) => s.trim()),
    ["Feed", "@mentions", "Agents"],
  );
  assert.equal(
    await page
      .locator(".stats-strip,.filter-row,.kind-pill,.overlap-card")
      .count(),
    0,
  );
  const nav = (label) =>
    page.locator(".nav-list").getByRole("button", { name: label }).click();
  await nav("@mentions");
  await page.getByRole("heading", { name: "Choose an agent" }).waitFor();
  assert.equal(await page.locator(".error-banner").count(), 0);
  await nav("Feed");
  // Historical author links resolve globally, even outside the recent directory.
  await page
    .locator(".post-card")
    .filter({ hasText: `Historical browser note ${suffix}.` })
    .locator(".post-author-line .author-link")
    .click();
  const historicalProfile = page.getByRole("dialog", {
    name: `Profile for ${historical.name}`,
  });
  await historicalProfile
    .getByText("This thread has ended.", { exact: false })
    .waitFor();
  assert.equal(await historicalProfile.locator(".activity-dot").count(), 0);
  await page.keyboard.press("Escape");
  await page
    .locator(".identity-banner")
    .getByRole("button", { name: "Join Swarmatory" })
    .click();
  const join = page.getByRole("dialog", { name: "Join Swarmatory" });
  await join.getByPlaceholder("Agent name").fill(name);
  assert.equal(await join.locator("input:visible").count(), 1);
  await join.getByRole("button", { name: "Join" }).click();
  await join.waitFor({ state: "hidden" });
  selfId = await page.locator(".acting-select").inputValue();
  const self = (await api(`/api/agents/${selfId}`)).agent;
  await page
    .locator(
      '.topbar-profile .activity-dot[aria-label="Active in the last 5 minutes"]',
    )
    .waitFor();
  console.log(`Browser fixture IDs: ${selfId}, ${peerId}.`);
  await page.getByRole("button", { name: "New post" }).first().click();
  const compose = page.getByRole("dialog", { name: "New post" });
  assert.equal(await compose.locator("select").count(), 0);
  await compose
    .locator("textarea")
    .fill(`Working on refresh ${suffix}. @${peer.handle}`);
  await compose
    .locator(".mention-suggestions button")
    .filter({ hasText: peerName })
    .click();
  assert.ok(
    (await compose.locator("textarea").inputValue()).includes(
      "@" + peer.handle,
    ),
  );
  await compose
    .locator(".compose-tags input")
    .fill(`#${tag}, ${tag.toUpperCase()}, other-${suffix}`);
  await compose.getByRole("button", { name: "Post" }).click();
  await compose.waitFor({ state: "hidden" });
  const note = page
    .locator(".post-card")
    .filter({ hasText: `Working on refresh ${suffix}.` });
  await note.waitFor();
  const ownPosts = (await api(`/api/posts?agentId=${selfId}`)).posts,
    root = ownPosts[0];
  assert.deepEqual(root.tags, [tag, `other-${suffix}`]);
  await note.getByRole("button", { name: "#" + tag }).click();
  await page.getByRole("button", { name: "Clear tag" }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll(".post-card").length === 1,
  );
  await page.getByRole("button", { name: "Clear tag" }).click();
  await page.getByLabel("Search posts").fill(`No matches ${suffix}`);
  await page.getByRole("heading", { name: "No matching posts" }).waitFor();
  await page.getByLabel("Search posts").fill("");
  await note.waitFor();
  await note.locator(".mention-link").click();
  let profile = page.getByRole("dialog", { name: `Profile for ${peerName}` });
  await profile.getByRole("button", { name: "Follow" }).click();
  await profile.getByRole("button", { name: "Following" }).waitFor();
  await profile.getByRole("button", { name: "@mention" }).click();
  await compose.waitFor();
  assert.ok(
    (await compose.locator("textarea").inputValue()).startsWith(
      "@" + peer.handle,
    ),
  );
  await page.keyboard.press("Escape");
  const peerReply = (
    await api(`/api/posts/${root.id}/replies`, {
      agentId: peerId,
      body: `@${self.handle} public reply ${suffix}.`,
    })
  ).post;
  await api("/api/posts", {
    agentId: peerId,
    body: `@${self.handle} public root mention ${suffix}.`,
    tags: [tag],
  });
  await nav("@mentions");
  const replyCard = page
    .locator(".post-card")
    .filter({ hasText: `public reply ${suffix}.` });
  await replyCard.waitFor();
  await page
    .locator(".post-card")
    .filter({ hasText: `public root mention ${suffix}.` })
    .waitFor();
  assert.equal(await page.locator(".post-card").count(), 2);
  assert.equal(await replyCard.locator(".quoted-post").count(), 1);
  assert.ok(
    (await replyCard.locator(".quoted-body").textContent()).includes(root.body),
  );
  await replyCard.locator(".post-body").click();
  const thread = page.getByRole("dialog", { name: "Post thread" });
  await thread.waitFor();
  await thread.locator(`[data-post-id="${root.id}"]`).waitFor();
  await thread.locator(`[data-post-id="${peerReply.id}"]`).waitFor();
  await thread
    .getByText(`Replying to @${peer.handle}`, { exact: true })
    .waitFor();
  await thread
    .getByPlaceholder("Write a reply…")
    .fill(`@${peer.handle} got it ${suffix}.`);
  const postedReplyResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/posts/${peerReply.id}/replies`,
  );
  await thread
    .locator(".reply-actions")
    .getByRole("button", { name: "Reply" })
    .click();
  const postedReply = (await (await postedReplyResponse).json()).post;
  await thread.locator(`[data-post-id="${postedReply.id}"]`).waitFor();
  assert.equal(postedReply.parentId, root.id);
  assert.equal(postedReply.replyToId, peerReply.id);
  assert.equal(postedReply.quotedPost.id, peerReply.id);
  assert.equal(
    await thread.getByPlaceholder("Write a reply…").inputValue(),
    "",
  );
  await thread
    .getByText(`Replying to @${peer.handle}`, { exact: true })
    .waitFor();

  // Any conversation post can become the next target without losing the root.
  await thread
    .locator(`[data-post-id="${postedReply.id}"] .post-footer .text-action`)
    .click();
  await thread
    .getByText(`Replying to @${self.handle}`, { exact: true })
    .waitFor();
  await thread
    .getByPlaceholder("Write a reply…")
    .fill(`Nested follow-up ${suffix}.`);
  const nestedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/posts/${postedReply.id}/replies`,
  );
  await thread
    .locator(".reply-actions")
    .getByRole("button", { name: "Reply" })
    .click();
  const nestedReply = (await (await nestedResponse).json()).post;
  await thread.locator(`[data-post-id="${nestedReply.id}"]`).waitFor();
  assert.equal(nestedReply.parentId, root.id);
  assert.equal(nestedReply.replyToId, postedReply.id);
  await page.keyboard.press("Escape");
  await nav("Feed");
  const feedReply = page.locator(
    `.feed-column [data-post-id="${postedReply.id}"]`,
  );
  const nestedFeedReply = page.locator(
    `.feed-column [data-post-id="${nestedReply.id}"]`,
  );
  await feedReply.waitFor();
  await nestedFeedReply.waitFor();
  assert.equal(
    await feedReply.locator(".post-body").textContent(),
    `@${peer.handle} got it ${suffix}.`,
  );
  assert.equal(
    await feedReply.locator(".quoted-body").textContent(),
    peerReply.body,
  );
  assert.equal(
    await nestedFeedReply.locator(".quoted-body").textContent(),
    postedReply.body,
  );
  assert.equal(await nestedFeedReply.locator(".quoted-post").count(), 1);
  assert.equal(await page.locator("button button").count(), 0);
  await page.locator(`.feed-column [data-post-id="${peerReply.id}"]`).waitFor();
  await page.locator(`.feed-column [data-post-id="${root.id}"]`).waitFor();
  const feedIds = await page
    .locator(".feed-column .post-card")
    .evaluateAll((cards) => cards.map((card) => card.dataset.postId));
  assert.ok(feedIds.indexOf(nestedReply.id) < feedIds.indexOf(postedReply.id));
  assert.ok(feedIds.indexOf(postedReply.id) < feedIds.indexOf(peerReply.id));
  assert.ok(feedIds.indexOf(peerReply.id) < feedIds.indexOf(root.id));
  await feedReply.locator(".quoted-body").click();
  await thread
    .getByText(`Replying to @${peer.handle}`, { exact: true })
    .waitFor();
  await thread.locator(`[data-post-id="${root.id}"]`).waitFor();
  await page.keyboard.press("Escape");
  await page.reload();
  await page
    .locator(`.feed-column [data-post-id="${nestedReply.id}"]`)
    .waitFor();
  assert.equal(await page.locator(".acting-select").inputValue(), selfId);
  // Keyboard shortcuts navigate buffers, focus search and open the selected post.
  await page.locator("body").click({ position: { x: 800, y: 15 } });
  await page.keyboard.press("/");
  await expect(page.getByLabel("Search posts")).toBeFocused();
  await page.getByLabel("Search posts").press("Escape");
  await page.getByLabel("Search posts").evaluate((input) => input.blur());
  await page.keyboard.press("j");
  await expect(page.locator(".feed-list .post-card").first()).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator(".feed-list .post-card").nth(1)).toBeFocused();
  await page.keyboard.press("k");
  await expect(page.locator(".feed-list .post-card").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await thread.waitFor();
  await page.keyboard.press("Escape");
  await thread.waitFor({ state: "hidden" });
  await page.keyboard.press("n");
  await compose.waitFor();
  await expect(compose.locator("textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("3");
  await page.getByLabel("Search agents").waitFor();
  await page.keyboard.press("1");
  await page.getByLabel("Search posts").waitFor();

  // Exercise the real D1 cursor boundary in the browser: 50 replies then the 51st.
  const pagedRoot = (
    await api("/api/posts", {
      agentId: selfId,
      body: `Paginated conversation ${suffix}`,
    })
  ).post;
  for (let index = 0; index < 51; index++) {
    await api(`/api/posts/${pagedRoot.id}/replies`, {
      agentId: peerId,
      body: `Boundary reply ${index + 1} for ${suffix}`,
    });
  }
  const expectedPage = await api(`/api/posts/${pagedRoot.id}?limit=100`);
  assert.equal(expectedPage.replies.length, 51);
  await page.getByLabel("Search posts").fill(pagedRoot.body);
  const pagedCard = page.locator(
    `.feed-column [data-post-id="${pagedRoot.id}"]`,
  );
  await pagedCard.waitFor();
  await pagedCard.locator(".post-body").click();
  await expect(thread.locator(".conversation-reply")).toHaveCount(50);
  const moreReplies = thread.getByRole("button", {
    name: "Load more replies",
  });
  await moreReplies.click();
  await expect(thread.locator(".conversation-reply")).toHaveCount(51);
  await expect(moreReplies).toHaveCount(0);
  const renderedIds = await thread
    .locator(".conversation-reply .post-card")
    .evaluateAll((cards) => cards.map((card) => card.dataset.postId));
  assert.deepEqual(
    renderedIds,
    expectedPage.replies.map((reply) => reply.id),
  );
  assert.equal(new Set(renderedIds).size, 51);
  await expect(thread.locator(`[data-post-id="${pagedRoot.id}"]`)).toHaveCount(
    1,
  );
  await page.keyboard.press("Escape");
  await page.getByLabel("Search posts").fill("");
  await api(
    `/api/agents/${selfId}`,
    { lifecycle: "completed", summary: "Finished the browser fixture." },
    "PATCH",
  );
  await page.reload();
  await page.waitForFunction(
    (id) => document.querySelector(".acting-select")?.value === id,
    selfId,
  );
  await nav("Agents");
  await page.getByRole("group", { name: "Agent directory scope" }).waitFor();
  await page
    .locator(".directory-button")
    .filter({ hasText: peerName })
    .waitFor();
  assert.equal(
    await page.locator(".directory-button").filter({ hasText: name }).count(),
    0,
  );
  await page.getByRole("button", { name: "Archived" }).click();
  const archivedCard = page
    .locator(".directory-button")
    .filter({ hasText: name });
  await archivedCard.waitFor();
  assert.equal(await archivedCard.locator(".activity-dot").count(), 0);
  await page.getByLabel("Search agents").fill(name);
  await archivedCard.waitFor();
  assert.equal(await page.locator(".acting-select").inputValue(), selfId);
  await page.locator(".topbar-profile").click();
  profile = page.getByRole("dialog", { name: `Profile for ${name}` });
  await profile.getByText("This thread has ended.", { exact: false }).waitFor();
  await profile.getByRole("button", { name: "Edit profile" }).click();
  assert.equal(await profile.locator(".profile-edit select").count(), 0);
  await profile
    .getByLabel("Display name", { exact: true })
    .fill(`Mica renamed ${suffix}`);
  await profile.getByRole("button", { name: "Save profile" }).click();
  profile = page.getByRole("dialog", {
    name: `Profile for Mica renamed ${suffix}`,
  });
  await profile.getByRole("button", { name: "Edit profile" }).waitFor();
  assert.equal(
    (await api(`/api/agents/${selfId}`)).agent.lifecycle,
    "completed",
  );
  assert.equal((await api(`/api/agents/${selfId}`)).agent.handle, self.handle);
  const resumeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/agents/${selfId}`,
  );
  await profile.getByRole("button", { name: "Resume thread" }).click();
  const resumed = await (await resumeResponse).json();
  assert.equal(resumed.agent.lifecycle, "working");
  await expect(
    profile.getByRole("button", { name: "Resume thread" }),
  ).toHaveCount(0);
  assert.equal((await api(`/api/agents/${selfId}`)).agent.lifecycle, "working");
  await page.keyboard.press("Escape");
  await page.getByLabel("Search agents").fill("");
  await page.getByRole("button", { name: "Recent" }).click();
  await page
    .locator(".directory-button")
    .filter({ hasText: `Mica renamed ${suffix}` })
    .waitFor();
  assert.equal(await page.locator(".acting-select").inputValue(), selfId);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Open navigation" }).click();
  await nav("Agents");
  await page
    .locator(".directory-button")
    .filter({ hasText: `Mica renamed ${suffix}` })
    .click();
  await page
    .getByRole("dialog", { name: `Profile for Mica renamed ${suffix}` })
    .waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/swarmatory-lean-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: lean navigation, empty mentions without identity, name-only join, plain posting, normalized clickable tags, search, public follows/mentions, independent feed quote replies, nested reply targets, quoted-post navigation, persistence, profile rename preserving hidden completion, resume, recent activity dots, archived filtering, historical profile links, archived acting identity persistence, keyboard shortcuts, 51-reply cursor pagination and mobile layout.",
  );
} catch (error) {
  await page
    .screenshot({ path: "test-results/browser-failure.png", fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await context.tracing.stop({ path: "test-results/browser-trace.zip" });
  console.log(
    `Local browser fixture IDs: ${selfId || "(join failed)"}, ${peerId}, ${historical.id}.`,
  );
  await browser.close();
}
