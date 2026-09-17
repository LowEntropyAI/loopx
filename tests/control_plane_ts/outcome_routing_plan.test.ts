import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTCOME_ROUTING_PLAN_REQUEST_SCHEMA_VERSION,
  projectOutcomeRoutingPlan,
} from "../../loopx/control_plane/work_items/outcome_routing_plan.ts";

function request(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: OUTCOME_ROUTING_PLAN_REQUEST_SCHEMA_VERSION,
    direction: "Improve durable customer value.",
    cycle: 3,
    outcomes: [{
      outcome_id: "outcome_activation",
      title: "Improve activation",
      metric: "seven day activation rate",
      target: ">= 40%",
      evidence_source: "activation analytics",
    }],
    work_items: [],
    feedback: [],
    ...overrides,
  };
}

function work(overrides: Record<string, unknown> = {}) {
  return {
    work_item_id: "work_activation_analysis",
    outcome_id: "outcome_activation",
    title: "Analyze the activation funnel.",
    acceptance: "Baseline every stage and propose three measurable experiments.",
    authority_tier: "A",
    ai_capable: true,
    target_key: "activation_funnel_analysis",
    ...overrides,
  };
}

test("outcome routing loop routes AI work into an advancement Todo", () => {
  const result = projectOutcomeRoutingPlan(request({ work_items: [work()] }));
  const item = (result.work_items as Record<string, unknown>[])[0];

  assert.equal(result.schema_version, "outcome_routing_plan_v0");
  assert.equal(item.route, "ai_execute");
  assert.equal(item.status, "ready");
  assert.deepEqual(item.todo_projection, {
    role: "agent",
    task_class: "advancement_task",
    action_kind: "ai_execute",
    target_key: "activation_funnel_analysis",
    text: "Analyze the activation funnel.",
    acceptance: "Baseline every stage and propose three measurable experiments.",
  });
});

test("routing precedence preserves authority, waiting, and human boundaries", () => {
  const result = projectOutcomeRoutingPlan(request({
    work_items: [
      work({ work_item_id: "work_rejected", target_key: "target_rejected", prohibited: true }),
      work({ work_item_id: "work_observe", target_key: "target_observe", wait_for: "provider result" }),
      work({ work_item_id: "work_decide", target_key: "target_decide", material_decision: true }),
      work({ work_item_id: "work_execute", target_key: "target_execute", human_identity_required: true, owner: "employee:alice" }),
      work({ work_item_id: "work_incomplete", target_key: "target_incomplete", ai_capable: false }),
    ],
  }));

  assert.deepEqual(
    (result.work_items as Record<string, unknown>[]).map((item) => item.route),
    ["reject", "observe", "human_decide", "human_execute", "human_decide"],
  );
  assert.deepEqual(
    (result.work_items as Record<string, unknown>[]).map((item) =>
      (item.todo_projection as Record<string, unknown>).task_class
    ),
    ["blocker", "continuous_monitor", "user_gate", "user_action", "user_gate"],
  );
  assert.equal(((result.work_items as Record<string, any>[])[3].todo_projection).owner, "employee:alice");
  assert.throws(() => projectOutcomeRoutingPlan(request({
    work_items: [work({ human_identity_required: true })],
  })), /owner is required for human execution/);
});

test("material feedback creates an explicit replan signal", () => {
  const result = projectOutcomeRoutingPlan(request({
    feedback: [
      {
        feedback_id: "feedback_metric_change",
        source: "analytics",
        subject: "activation",
        kind: "metric_change",
        observed_at: "2026-09-17T00:00:00Z",
        evidence_ref: "report:activation-2026-09-17",
        affected_outcome_ids: ["outcome_activation"],
      },
      {
        feedback_id: "feedback_comment",
        source: "support",
        subject: "onboarding copy",
        kind: "comment",
        observed_at: "2026-09-17T00:01:00Z",
        evidence_ref: "ticket:123",
        affected_outcome_ids: ["outcome_activation"],
      },
    ],
  }));

  assert.equal(result.replan_required, true);
  assert.deepEqual(
    (result.feedback as Record<string, unknown>[]).map((item) => item.disposition),
    ["replan", "recorded"],
  );
});

test("outcome routing loop rejects dangling outcome references and unsafe ids", () => {
  assert.throws(
    () => projectOutcomeRoutingPlan(request({
      work_items: [work({ outcome_id: "outcome_missing" })],
    })),
    /outcome_id must reference an outcome/,
  );
  assert.throws(
    () => projectOutcomeRoutingPlan(request({
      work_items: [work({ target_key: "../../private" })],
    })),
    /target_key must be a public-safe id/,
  );
});

test("outcome routing loop rejects ambiguous identifiers and unsafe cycle integers", () => {
  assert.throws(
    () => projectOutcomeRoutingPlan(request({
      outcomes: [request().outcomes[0], request().outcomes[0]],
    })),
    /outcome_id values must be unique/,
  );
  assert.throws(
    () => projectOutcomeRoutingPlan(request({
      work_items: [
        work({ work_item_id: "work_first" }),
        work({ work_item_id: "work_second" }),
      ],
    })),
    /target_key values must be unique/,
  );
  assert.throws(
    () => projectOutcomeRoutingPlan(request({
      work_items: [
        work({ target_key: "target_first" }),
        work({ target_key: "target_second" }),
      ],
    })),
    /work_item_id values must be unique/,
  );
  const feedback = {
    feedback_id: "feedback_duplicate",
    source: "analytics",
    subject: "activation",
    kind: "fact",
    observed_at: "2026-09-17T00:00:00Z",
    evidence_ref: "report:activation",
    affected_outcome_ids: ["outcome_activation"],
  };
  assert.throws(
    () => projectOutcomeRoutingPlan(request({ feedback: [feedback, feedback] })),
    /feedback_id values must be unique/,
  );
  assert.throws(
    () => projectOutcomeRoutingPlan(request({ cycle: Number.MAX_SAFE_INTEGER + 1 })),
    /non-negative safe integer/,
  );
});
