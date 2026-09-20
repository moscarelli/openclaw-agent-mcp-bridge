import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgent,
  buildAgentsList,
  buildSession,
  buildSessionsPage,
} from "../src/openclaw/normalize.mjs";
import { syntheticSessionPath } from "./helpers/synthetic.mjs";

test("buildAgent reads only id and model (allowlist)", () => {
  const agent = buildAgent({ id: "main", model: "m", workspace: "/synthetic/ws", secret: "leak" });
  assert.deepEqual(agent, { id: "main", model: "m" });
});

test("buildAgentsList applies limit after normalization", () => {
  const parsed = { agents: [{ id: "a" }, { id: "b" }, { id: "c" }] };
  const result = buildAgentsList(parsed, 2);
  assert.equal(result.count, 2);
  assert.deepEqual(result.agents, [{ id: "a" }, { id: "b" }]);
});

test("buildSession never copies path or unknown/sensitive fields", () => {
  const session = buildSession({
    agentId: "main",
    key: "agent:main:s1",
    model: "m",
    path: syntheticSessionPath(),
    secret: "should-not-leak",
    futureField: "unknown",
  });
  assert.deepEqual(session, { agentId: "main", key: "agent:main:s1", model: "m" });
  assert.equal("path" in session, false);
  assert.equal("secret" in session, false);
  assert.equal("futureField" in session, false);
});

test("buildSessionsPage maps pagination metadata and defaults hasMore", () => {
  const parsed = {
    sessions: [{ key: "agent:main:s1" }],
    totalCount: 5,
    limitApplied: 100,
    hasMore: true,
    nextOffset: 100,
  };
  const page = buildSessionsPage(parsed, { limit: 100 });
  assert.equal(page.count, 1);
  assert.equal(page.totalCount, 5);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 100);
});

test("buildSessionsPage defaults hasMore to false when absent", () => {
  const page = buildSessionsPage({ sessions: [] });
  assert.equal(page.hasMore, false);
  assert.equal(page.count, 0);
});
