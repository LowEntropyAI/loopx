import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bindOutcomeRoutingTodos,
  OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA,
  OUTCOME_ROUTING_STATE_STORE_REQUEST_SCHEMA,
  outcomeRoutingStatePath,
  loadOutcomeRoutingState,
  planOutcomeRoutingNextCycle,
  recordOutcomeRoutingFeedback,
  reconcileOutcomeRoutingState,
  writeOutcomeRoutingState,
} from "../../loopx/control_plane/work_items/outcome_routing_state.ts";

function state(direction = "Improve durable customer value.") {
  return {
    schema_version: "outcome_routing_plan_request_v0",
    direction,
    cycle: 1,
    outcomes: [{
      outcome_id: "outcome_activation",
      title: "Improve activation",
      metric: "seven day activation rate",
      target: ">= 40%",
      evidence_source: "activation analytics",
    }],
    work_items: [],
    feedback: [],
  };
}

function stateWithWork() {
  const value = state();
  return {
    ...value,
    work_items: [{
      work_item_id: "work_activation",
      outcome_id: "outcome_activation",
      title: "Ship activation improvement",
      acceptance: "validated activation evidence",
      authority_tier: "A",
      ai_capable: true,
      target_key: "activation_delivery",
    }],
  };
}

function request(runtimeRoot: string, extra: Record<string, unknown> = {}) {
  return {
    schema_version: OUTCOME_ROUTING_STATE_STORE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    ...extra,
  };
}

test("outcome routing state writes atomically and reads back exact revision", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));

  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: state(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  assert.equal(first.written, true);
  const stored = first.state as Record<string, unknown>;
  assert.match(String(stored.revision), /^[a-f0-9]{64}$/);

  const loaded = await loadOutcomeRoutingState(request(runtimeRoot));
  assert.deepEqual(loaded.state, first.state);
  assert.equal(loaded.path, outcomeRoutingStatePath(runtimeRoot, "company-goal"));

  const replay = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: state(),
    updated_at: "2026-09-17T00:01:00Z",
  }));
  assert.equal(replay.written, false);
  assert.equal(replay.replayed, true);
});

test("outcome routing state requires revision matching for updates", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: state(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const stored = first.state as Record<string, unknown>;

  await assert.rejects(
    writeOutcomeRoutingState(request(runtimeRoot, {
      state: state("Changed direction."),
      updated_at: "2026-09-17T00:01:00Z",
    })),
    /expected_revision is required/,
  );
  await assert.rejects(
    writeOutcomeRoutingState(request(runtimeRoot, {
      state: state("Changed direction."),
      expected_revision: "0".repeat(64),
      updated_at: "2026-09-17T00:01:00Z",
    })),
    /revision changed/,
  );
  const updated = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: state("Changed direction."),
    expected_revision: stored.revision,
    updated_at: "2026-09-17T00:01:00Z",
  }));
  assert.equal(updated.written, true);
  assert.notEqual(
    (updated.state as Record<string, unknown>).revision,
    stored.revision,
  );
});

test("sourced human feedback survives restart and enters the next cycle without completing work", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-human-feedback-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const initial = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: stateWithWork(), updated_at: "2026-09-17T00:00:00Z",
  }));
  const feedback = {
    feedback_id: "feedback_employee_001",
    source: "employee:alice",
    subject: "Customer interview found onboarding friction",
    kind: "execution_result",
    observed_at: "2026-09-17T00:01:00Z",
    evidence_ref: "interview:2026-09-17-01",
    affected_outcome_ids: ["outcome_activation"],
  };
  const base = {
    schema_version: "outcome_routing_state_feedback_request_v0",
    runtime_root: runtimeRoot, goal_id: "company-goal",
    expected_revision: (initial.state as Record<string, any>).revision,
    updated_at: "2026-09-17T00:02:00Z", feedback,
  };
  await assert.rejects(recordOutcomeRoutingFeedback({ ...base, execute: false, feedback: { ...feedback, evidence_ref: "" } }), /evidence_ref/);
  const preview = await recordOutcomeRoutingFeedback({ ...base, execute: false });
  assert.equal(preview.written, false);
  assert.deepEqual((await loadOutcomeRoutingState(request(runtimeRoot))).state, initial.state);
  const recorded = await recordOutcomeRoutingFeedback({ ...base, execute: true });
  const restarted = (await loadOutcomeRoutingState(request(runtimeRoot))).state as Record<string, any>;
  assert.equal(restarted.revision, (recorded.state as Record<string, any>).revision);
  assert.equal(restarted.projection.feedback[0].evidence_ref, feedback.evidence_ref);
  const replay = await recordOutcomeRoutingFeedback({ ...base, expected_revision: restarted.revision, execute: true });
  assert.equal(replay.replayed, true);
  await assert.rejects(recordOutcomeRoutingFeedback({ ...base, expected_revision: restarted.revision, execute: true, feedback: { ...feedback, subject: "altered" } }), /different content/);
  const reconciled = await reconcileOutcomeRoutingState({
    schema_version: OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot, goal_id: "company-goal",
    expected_revision: restarted.revision,
    updated_at: "2026-09-17T00:03:00Z", execute: true,
    observations: [{ target_key: "activation_delivery", todo_id: "todo_activation", status: "open" }],
  });
  const next = planOutcomeRoutingNextCycle({
    schema_version: "outcome_routing_next_cycle_request_v0",
    goal_id: "company-goal", state: (await loadOutcomeRoutingState(request(runtimeRoot))).state,
  });
  assert.equal((next.state as Record<string, any>).feedback[0].feedback_id, feedback.feedback_id);
  assert.equal((next.state as Record<string, any>).work_items.length, 1);
  assert.equal((reconciled.state as Record<string, any>).reconciliation.observations[0].next_status, "ready");
});

test("Todo bindings are revisioned profile state with exact work identity", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-outcome-bind-"));
  t.after(async () => await rm(runtimeRoot, { recursive: true, force: true }));
  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: {
      ...stateWithWork(),
      direction: "Route human work without widening shared Todo identity.",
    },
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const stored = first.state as Record<string, any>;
  const bound = await bindOutcomeRoutingTodos({
    schema_version: "outcome_routing_state_bind_request_v0",
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    expected_revision: stored.revision,
    updated_at: "2026-09-17T00:01:00Z",
    todo_bindings: [{
      work_item_id: "work_activation",
      target_key: "activation_delivery",
      todo_id: "todo_human_decision",
      role: "user",
    }],
  });
  assert.notEqual((bound.state as Record<string, any>).revision, stored.revision);
  assert.deepEqual((bound.state as Record<string, any>).todo_bindings, [{
    work_item_id: "work_activation",
    target_key: "activation_delivery",
    todo_id: "todo_human_decision",
    role: "user",
  }]);
  await assert.rejects(
    bindOutcomeRoutingTodos({
      schema_version: "outcome_routing_state_bind_request_v0",
      runtime_root: runtimeRoot,
      goal_id: "company-goal",
      expected_revision: (bound.state as Record<string, any>).revision,
      updated_at: "2026-09-17T00:02:00Z",
      todo_bindings: [{
        work_item_id: "work_activation",
        target_key: "wrong_target",
        todo_id: "todo_human_decision",
        role: "user",
      }],
    }),
    /must match a projected work item and target/,
  );
});

test("outcome routing state path is bounded and rejects relative runtime roots", () => {
  const left = outcomeRoutingStatePath("/runtime", "company goal");
  const right = outcomeRoutingStatePath("/runtime", "company-goal");
  assert.notEqual(left, right);
  assert.match(left, /outcome-routing\/state\.json$/);
  assert.throws(
    () => outcomeRoutingStatePath("relative", "company-goal"),
    /runtime_root must be absolute/,
  );
});

test("outcome routing reconciliation previews and persists evidence-gated Todo status", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: stateWithWork(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const original = first.state as Record<string, unknown>;
  const reconcileRequest = {
    schema_version: OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    expected_revision: original.revision,
    updated_at: "2026-09-17T00:01:00Z",
    execute: false,
    observations: [{
      target_key: "activation_delivery",
      todo_id: "todo_activation",
      status: "done",
      evidence_ref: "artifact:activation-report",
    }],
  };
  const preview = await reconcileOutcomeRoutingState(reconcileRequest);
  assert.equal(preview.dry_run, true);
  assert.equal(preview.written, false);
  assert.equal(
    ((preview.state as Record<string, any>).reconciliation.observations[0]).next_status,
    "done",
  );
  assert.deepEqual((await loadOutcomeRoutingState(request(runtimeRoot))).state, first.state);

  const written = await reconcileOutcomeRoutingState({
    ...reconcileRequest,
    execute: true,
  });
  assert.equal(written.written, true);
  const reconciled = written.state as Record<string, any>;
  assert.notEqual(reconciled.revision, original.revision);
  assert.equal(reconciled.reconciliation.replan_required, false);
  assert.equal(reconciled.reconciliation.observations[0].evidence_ref, "artifact:activation-report");

  const replay = await reconcileOutcomeRoutingState({
    ...reconcileRequest,
    expected_revision: reconciled.revision,
    updated_at: "2026-09-17T00:02:00Z",
    execute: true,
  });
  assert.equal(replay.written, false);
  assert.equal(replay.replayed, true);
});

test("outcome routing reconciliation requests replanning for blocked or unproven completion", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: stateWithWork(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const revision = (first.state as Record<string, unknown>).revision;

  for (const [status, expected] of [
    ["blocked", "replanning"],
    ["done", "awaiting_evidence"],
  ] as const) {
    const result = await reconcileOutcomeRoutingState({
      schema_version: OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA,
      runtime_root: runtimeRoot,
      goal_id: "company-goal",
      expected_revision: revision,
      updated_at: "2026-09-17T00:01:00Z",
      execute: false,
      observations: [{
        target_key: "activation_delivery",
        todo_id: "todo_activation",
        status,
      }],
    });
    const reconciliation = (result.state as Record<string, any>).reconciliation;
    assert.equal(reconciliation.replan_required, true);
    assert.equal(reconciliation.observations[0].next_status, expected);
  }
});

test("outcome routing reconciliation rejects stale revisions and unknown targets", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: stateWithWork(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const revision = (first.state as Record<string, unknown>).revision;
  const base = {
    schema_version: OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    expected_revision: revision,
    updated_at: "2026-09-17T00:01:00Z",
    execute: false,
  };
  await assert.rejects(
    reconcileOutcomeRoutingState({
      ...base,
      expected_revision: "0".repeat(64),
      observations: [],
    }),
    /revision changed/,
  );
  await assert.rejects(
    reconcileOutcomeRoutingState({
      ...base,
      observations: [{
        target_key: "unknown_target",
        todo_id: "todo_unknown",
        status: "open",
      }],
    }),
    /is unknown/,
  );
});

test("next company cycle converts evidence and blockers into feedback and replanning", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const input = stateWithWork();
  input.work_items.push({
    work_item_id: "work_retention",
    outcome_id: "outcome_activation",
    title: "Resolve retention risk",
    acceptance: "risk is cleared",
    authority_tier: "A",
    ai_capable: true,
    target_key: "retention_risk",
  });
  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: input,
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const reconciled = await reconcileOutcomeRoutingState({
    schema_version: OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    expected_revision: (first.state as Record<string, unknown>).revision,
    updated_at: "2026-09-17T00:01:00Z",
    execute: true,
    observations: [
      {
        target_key: "activation_delivery",
        todo_id: "todo_activation",
        status: "done",
        evidence_ref: "artifact:activation-report",
      },
      {
        target_key: "retention_risk",
        todo_id: "todo_retention",
        status: "blocked",
      },
    ],
  });
  const next = planOutcomeRoutingNextCycle({
    schema_version: "outcome_routing_next_cycle_request_v0",
    goal_id: "company-goal",
    state: reconciled.state,
  });
  assert.equal(next.goal_converged, false);
  assert.equal(next.converged_work_item_count, 1);
  assert.equal(next.remaining_work_item_count, 1);
  assert.equal(next.replan_required, true);
  const nextState = next.state as Record<string, any>;
  assert.equal(nextState.cycle, 2);
  assert.deepEqual(
    nextState.work_items.map((item: Record<string, unknown>) => item.work_item_id),
    ["work_retention"],
  );
  assert.deepEqual(
    nextState.feedback.map((item: Record<string, unknown>) => item.kind),
    ["execution_result", "risk"],
  );
});

test("next company cycle reports goal convergence after all work has evidence", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: stateWithWork(),
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const reconciled = await reconcileOutcomeRoutingState({
    schema_version: OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    expected_revision: (first.state as Record<string, unknown>).revision,
    updated_at: "2026-09-17T00:01:00Z",
    execute: true,
    observations: [{
      target_key: "activation_delivery",
      todo_id: "todo_activation",
      status: "done",
      evidence_ref: "artifact:activation-report",
    }],
  });
  const next = planOutcomeRoutingNextCycle({
    schema_version: "outcome_routing_next_cycle_request_v0",
    goal_id: "company-goal",
    state: reconciled.state,
  });
  assert.equal(next.goal_converged, true);
  assert.equal(next.remaining_work_item_count, 0);
  assert.equal(next.replan_required, true);
});

test("next company cycle keeps derived feedback ids valid for maximum-length work ids", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "loopx-company-state-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const input = stateWithWork();
  input.work_items[0].work_item_id = `w${"a".repeat(127)}`;
  const first = await writeOutcomeRoutingState(request(runtimeRoot, {
    state: input,
    updated_at: "2026-09-17T00:00:00Z",
  }));
  const reconciled = await reconcileOutcomeRoutingState({
    schema_version: OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA,
    runtime_root: runtimeRoot,
    goal_id: "company-goal",
    expected_revision: (first.state as Record<string, unknown>).revision,
    updated_at: "2026-09-17T00:01:00Z",
    execute: true,
    observations: [{
      target_key: "activation_delivery",
      todo_id: "todo_activation",
      status: "done",
      evidence_ref: "artifact:activation-report",
    }],
  });

  const next = planOutcomeRoutingNextCycle({
    schema_version: "outcome_routing_next_cycle_request_v0",
    goal_id: "company-goal",
    state: reconciled.state,
  });
  const feedback = (next.state as Record<string, any>).feedback[0];
  assert.match(feedback.feedback_id, /^todo_feedback_[a-f0-9]{24}$/);
  assert.ok(feedback.feedback_id.length <= 128);
  assert.deepEqual(
    planOutcomeRoutingNextCycle({
      schema_version: "outcome_routing_next_cycle_request_v0",
      goal_id: "company-goal",
      state: reconciled.state,
    }).state,
    next.state,
  );
});
