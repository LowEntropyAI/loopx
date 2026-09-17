import { EffectRuntimeRequestError } from "../effect_runtime_errors.ts";
import {
  optionalNonEmptyString,
  requireBoolean,
  requireInteger,
  requireJsonObject,
  requireNonEmptyString,
  requireStringArray,
  requireStringLiteral,
} from "../runtime_decode.ts";

import type { JsonObject } from "../effect_program.ts";

export const OUTCOME_ROUTING_PLAN_REQUEST_SCHEMA_VERSION =
  "outcome_routing_plan_request_v0";
export const OUTCOME_ROUTING_PLAN_SCHEMA_VERSION = "outcome_routing_plan_v0";
const MAX_OUTCOMES = 128;
const MAX_WORK_ITEMS = 256;
const MAX_FEEDBACK_ITEMS = 256;
const PUBLIC_ID = /^[a-z][a-z0-9_-]{2,127}$/;

export const OUTCOME_WORK_ROUTES = [
  "ai_execute",
  "human_decide",
  "human_execute",
  "observe",
  "reject",
] as const;

export type OutcomeWorkRoute = (typeof OUTCOME_WORK_ROUTES)[number];
export type OutcomeAuthorityTier = "A" | "B" | "C" | "D";

interface OutcomeWorkItem extends JsonObject {
  work_item_id: string;
  outcome_id: string;
  title: string;
  acceptance: string;
  authority_tier: OutcomeAuthorityTier;
  ai_capable: boolean;
  prohibited: boolean;
  material_decision: boolean;
  human_identity_required: boolean;
  owner?: string;
  wait_for?: string;
  target_key: string;
}

interface RoutedOutcomeWorkItem extends OutcomeWorkItem {
  route: OutcomeWorkRoute;
  route_reason: string;
  status:
    | "ready"
    | "waiting_human_decision"
    | "waiting_human_execution"
    | "waiting_external_evidence"
    | "cancelled";
  todo_projection: JsonObject;
}

function boundedArray(
  value: unknown,
  label: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new EffectRuntimeRequestError(`${label} must be an array`);
  }
  if (value.length > maximum) {
    throw new EffectRuntimeRequestError(
      `${label} must contain at most ${maximum} items`,
    );
  }
  return value;
}

function publicId(value: unknown, label: string): string {
  const normalized = requireNonEmptyString(value, label);
  if (!PUBLIC_ID.test(normalized)) {
    throw new EffectRuntimeRequestError(`${label} must be a public-safe id`);
  }
  return normalized;
}

function requireUniqueIds(
  values: readonly JsonObject[],
  field: string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identifier = String(value[field]);
    if (seen.has(identifier)) {
      throw new EffectRuntimeRequestError(`${label} must be unique`);
    }
    seen.add(identifier);
  }
}

function outcomeWorkItem(value: unknown, label: string): OutcomeWorkItem {
  const raw = requireJsonObject(value, label);
  const waitFor = optionalNonEmptyString(raw.wait_for, `${label}.wait_for`);
  const owner = optionalNonEmptyString(raw.owner, `${label}.owner`);
  return {
    work_item_id: publicId(raw.work_item_id, `${label}.work_item_id`),
    outcome_id: publicId(raw.outcome_id, `${label}.outcome_id`),
    title: requireNonEmptyString(raw.title, `${label}.title`),
    acceptance: requireNonEmptyString(raw.acceptance, `${label}.acceptance`),
    authority_tier: requireStringLiteral(
      raw.authority_tier,
      ["A", "B", "C", "D"] as const,
      `${label}.authority_tier`,
    ),
    ai_capable: requireBoolean(raw.ai_capable, `${label}.ai_capable`),
    prohibited: raw.prohibited === undefined
      ? false
      : requireBoolean(raw.prohibited, `${label}.prohibited`),
    material_decision: raw.material_decision === undefined
      ? false
      : requireBoolean(raw.material_decision, `${label}.material_decision`),
    human_identity_required: raw.human_identity_required === undefined
      ? false
      : requireBoolean(
        raw.human_identity_required,
        `${label}.human_identity_required`,
      ),
    ...(waitFor === null ? {} : { wait_for: waitFor }),
    ...(owner === null ? {} : { owner }),
    target_key: publicId(raw.target_key, `${label}.target_key`),
  };
}

export function routeOutcomeWorkItem(
  item: OutcomeWorkItem,
): { route: OutcomeWorkRoute; reason: string } {
  if (item.prohibited || item.authority_tier === "D") {
    return {
      route: "reject",
      reason: "policy or current authority prohibits execution",
    };
  }
  if (item.wait_for) {
    return {
      route: "observe",
      reason: "work depends on a future external state",
    };
  }
  if (item.material_decision || item.authority_tier === "B") {
    return {
      route: "human_decide",
      reason: "a material choice or authority grant is required",
    };
  }
  if (item.human_identity_required || item.authority_tier === "C") {
    return {
      route: "human_execute",
      reason: "a human identity or physical action is required",
    };
  }
  if (item.ai_capable && item.authority_tier === "A") {
    return {
      route: "ai_execute",
      reason: "AI capability, authority, and acceptance criteria are present",
    };
  }
  return {
    route: "human_decide",
    reason: "AI execution preconditions are incomplete",
  };
}

function routeStatus(route: OutcomeWorkRoute): RoutedOutcomeWorkItem["status"] {
  switch (route) {
    case "ai_execute": return "ready";
    case "human_decide": return "waiting_human_decision";
    case "human_execute": return "waiting_human_execution";
    case "observe": return "waiting_external_evidence";
    case "reject": return "cancelled";
  }
}

function todoProjection(item: OutcomeWorkItem, route: OutcomeWorkRoute): JsonObject {
  const mapping: Record<OutcomeWorkRoute, readonly [string, string]> = {
    ai_execute: ["agent", "advancement_task"],
    human_decide: ["user", "user_gate"],
    human_execute: ["user", "user_action"],
    observe: ["agent", "continuous_monitor"],
    reject: ["agent", "blocker"],
  };
  const [role, taskClass] = mapping[route];
  return {
    role,
    task_class: taskClass,
    action_kind: route,
    target_key: item.target_key,
    text: item.title,
    acceptance: item.acceptance,
    ...(item.owner ? { owner: item.owner } : {}),
  };
}

function projectWorkItem(value: unknown, label: string): RoutedOutcomeWorkItem {
  const item = outcomeWorkItem(value, label);
  const decision = routeOutcomeWorkItem(item);
  if (decision.route === "human_execute" && !item.owner) {
    throw new EffectRuntimeRequestError(`${label}.owner is required for human execution`);
  }
  return {
    ...item,
    route: decision.route,
    route_reason: decision.reason,
    status: routeStatus(decision.route),
    todo_projection: todoProjection(item, decision.route),
  };
}

function projectFeedback(value: unknown, label: string): JsonObject {
  const raw = requireJsonObject(value, label);
  const kind = requireStringLiteral(
    raw.kind,
    [
      "fact",
      "decision",
      "execution_result",
      "risk",
      "metric_change",
      "comment",
    ] as const,
    `${label}.kind`,
  );
  return {
    feedback_id: publicId(raw.feedback_id, `${label}.feedback_id`),
    source: requireNonEmptyString(raw.source, `${label}.source`),
    subject: requireNonEmptyString(raw.subject, `${label}.subject`),
    kind,
    observed_at: requireNonEmptyString(raw.observed_at, `${label}.observed_at`),
    evidence_ref: requireNonEmptyString(raw.evidence_ref, `${label}.evidence_ref`),
    affected_outcome_ids: requireStringArray(
      raw.affected_outcome_ids,
      `${label}.affected_outcome_ids`,
    ).map((item, index) => publicId(
      item,
      `${label}.affected_outcome_ids[${index}]`,
    )),
    disposition: kind === "comment" ? "recorded" : "replan",
  };
}

/**
 * Validate one outcome-level planning snapshot and project each open unit of
 * work into LoopX's existing Todo lanes. This is a pure control-plane
 * contract: providers own collection and execution, while LoopX owns routing
 * precedence and the provider-neutral projection.
 */
export function projectOutcomeRoutingPlan(value: unknown): JsonObject {
  const request = requireJsonObject(value, "outcome_routing_plan_request");
  if (request.schema_version !== OUTCOME_ROUTING_PLAN_REQUEST_SCHEMA_VERSION) {
    throw new EffectRuntimeRequestError(
      `outcome_routing_plan_request.schema_version must be ${OUTCOME_ROUTING_PLAN_REQUEST_SCHEMA_VERSION}`,
    );
  }
  const cycle = requireInteger(request.cycle, "outcome_routing_plan_request.cycle");
  if (cycle < 0 || !Number.isSafeInteger(cycle)) {
    throw new EffectRuntimeRequestError(
      "outcome_routing_plan_request.cycle must be a non-negative safe integer",
    );
  }
  const outcomes = boundedArray(
    request.outcomes,
    "outcome_routing_plan_request.outcomes",
    MAX_OUTCOMES,
  ).map((value, index) => {
    const raw = requireJsonObject(
      value,
      `outcome_routing_plan_request.outcomes[${index}]`,
    );
    return {
      outcome_id: publicId(
        raw.outcome_id,
        `outcome_routing_plan_request.outcomes[${index}].outcome_id`,
      ),
      title: requireNonEmptyString(
        raw.title,
        `outcome_routing_plan_request.outcomes[${index}].title`,
      ),
      metric: requireNonEmptyString(
        raw.metric,
        `outcome_routing_plan_request.outcomes[${index}].metric`,
      ),
      target: requireNonEmptyString(
        raw.target,
        `outcome_routing_plan_request.outcomes[${index}].target`,
      ),
      evidence_source: requireNonEmptyString(
        raw.evidence_source,
        `outcome_routing_plan_request.outcomes[${index}].evidence_source`,
      ),
    };
  });
  requireUniqueIds(outcomes, "outcome_id", "outcome_id values");
  const outcomeIds = new Set(outcomes.map((outcome) => outcome.outcome_id));
  const workItems = boundedArray(
    request.work_items,
    "outcome_routing_plan_request.work_items",
    MAX_WORK_ITEMS,
  ).map((item, index) => projectWorkItem(
    item,
    `outcome_routing_plan_request.work_items[${index}]`,
  ));
  requireUniqueIds(workItems, "work_item_id", "outcome work_item_id values");
  requireUniqueIds(workItems, "target_key", "outcome work target_key values");
  for (const [index, item] of workItems.entries()) {
    if (!outcomeIds.has(item.outcome_id)) {
      throw new EffectRuntimeRequestError(
        `outcome_routing_plan_request.work_items[${index}].outcome_id must reference an outcome`,
      );
    }
  }
  const feedback = boundedArray(
    request.feedback,
    "outcome_routing_plan_request.feedback",
    MAX_FEEDBACK_ITEMS,
  ).map((item, index) => projectFeedback(
    item,
    `outcome_routing_plan_request.feedback[${index}]`,
  ));
  requireUniqueIds(feedback, "feedback_id", "feedback_id values");
  for (const [index, item] of feedback.entries()) {
    for (const outcomeId of item.affected_outcome_ids as string[]) {
      if (!outcomeIds.has(outcomeId)) {
        throw new EffectRuntimeRequestError(
          `outcome_routing_plan_request.feedback[${index}].affected_outcome_ids must reference outcomes`,
        );
      }
    }
  }
  return {
    schema_version: OUTCOME_ROUTING_PLAN_SCHEMA_VERSION,
    direction: requireNonEmptyString(
      request.direction,
      "outcome_routing_plan_request.direction",
    ),
    cycle,
    outcomes,
    work_items: workItems,
    feedback,
    replan_required: feedback.some((item) => item.disposition === "replan"),
  };
}
