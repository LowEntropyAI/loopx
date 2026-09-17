import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { JsonObject } from "../effect_program.ts";
import {
  EffectRuntimeConflictError,
  EffectRuntimeRequestError,
} from "../effect_runtime_errors.ts";
import { atomicWriteJson, withFileMutationLock } from "../effect_runtime_io.ts";
import {
  optionalNonEmptyString,
  requireBoolean,
  requireJsonObject,
  requireNonEmptyString,
  requireStringLiteral,
} from "../runtime_decode.ts";
import {
  OUTCOME_ROUTING_PLAN_SCHEMA_VERSION,
  projectOutcomeRoutingPlan,
} from "./outcome_routing_plan.ts";

export const OUTCOME_ROUTING_STATE_STORE_REQUEST_SCHEMA =
  "outcome_routing_state_store_request_v0";
export const OUTCOME_ROUTING_STATE_STORE_SCHEMA =
  "outcome_routing_state_store_v0";
export const OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA =
  "outcome_routing_state_store_result_v0";
export const OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA =
  "outcome_routing_state_reconcile_request_v0";
export const OUTCOME_ROUTING_STATE_RECONCILIATION_SCHEMA =
  "outcome_routing_state_reconciliation_v0";
export const OUTCOME_ROUTING_STATE_BIND_REQUEST_SCHEMA =
  "outcome_routing_state_bind_request_v0";
export const OUTCOME_ROUTING_STATE_FEEDBACK_REQUEST_SCHEMA =
  "outcome_routing_state_feedback_request_v0";
export const OUTCOME_ROUTING_STATE_INBOX_REQUEST_SCHEMA =
  "outcome_routing_state_inbox_request_v0";
export const OUTCOME_ROUTING_NEXT_CYCLE_REQUEST_SCHEMA =
  "outcome_routing_next_cycle_request_v0";
export const OUTCOME_ROUTING_NEXT_CYCLE_SCHEMA =
  "outcome_routing_next_cycle_v0";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function revision(projection: JsonObject): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(projection)), "utf8")
    .digest("hex");
}

function todoFeedbackId(
  workItemId: string,
  nextStatus: string,
  todoId: string,
  cycle: number,
): string {
  const digest = createHash("sha256")
    .update(`${workItemId}\u001f${nextStatus}\u001f${todoId}\u001f${cycle}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `todo_feedback_${digest}`;
}

function safeGoalSegment(goalId: string): string {
  const label = goalId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 47) || "goal";
  const digest = createHash("sha256").update(goalId, "utf8").digest("hex").slice(0, 16);
  return `${label}-${digest}`;
}

export function outcomeRoutingStatePath(runtimeRoot: string, goalId: string): string {
  if (!isAbsolute(runtimeRoot)) {
    throw new EffectRuntimeRequestError("runtime_root must be absolute");
  }
  return join(
    runtimeRoot,
    "goals",
    safeGoalSegment(goalId),
    "outcome-routing",
    "state.json",
  );
}

function storeRequest(value: unknown): {
  request: JsonObject;
  goalId: string;
  path: string;
} {
  const request = requireJsonObject(value, "outcome_routing_state_store params");
  if (request.schema_version !== OUTCOME_ROUTING_STATE_STORE_REQUEST_SCHEMA) {
    throw new EffectRuntimeRequestError("outcome routing state store request schema mismatch");
  }
  const runtimeRoot = requireNonEmptyString(request.runtime_root, "runtime_root");
  const goalId = requireNonEmptyString(request.goal_id, "goal_id");
  return { request, goalId, path: outcomeRoutingStatePath(runtimeRoot, goalId) };
}

function decodeStoredState(value: unknown, goalId: string): JsonObject {
  const stored = requireJsonObject(value, "stored outcome routing state");
  if (
    stored.schema_version !== OUTCOME_ROUTING_STATE_STORE_SCHEMA ||
    stored.goal_id !== goalId ||
    typeof stored.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(stored.revision)
  ) {
    throw new EffectRuntimeRequestError("stored outcome routing state is invalid");
  }
  const projection = requireJsonObject(stored.projection, "stored projection");
  if (projection.schema_version !== OUTCOME_ROUTING_PLAN_SCHEMA_VERSION) {
    throw new EffectRuntimeRequestError("stored outcome routing projection schema is invalid");
  }
  const bindings = stored.todo_bindings === undefined
    ? []
    : requireBindings(stored.todo_bindings, projection);
  const reconciliation = stored.reconciliation === undefined
    ? null
    : requireJsonObject(stored.reconciliation, "stored reconciliation");
  if (
    reconciliation !== null &&
    reconciliation.schema_version !== OUTCOME_ROUTING_STATE_RECONCILIATION_SCHEMA
  ) {
    throw new EffectRuntimeRequestError("stored outcome routing reconciliation is invalid");
  }
  const revisionContent: JsonObject = { projection };
  if (bindings.length > 0) revisionContent.todo_bindings = bindings;
  if (reconciliation !== null) revisionContent.reconciliation = reconciliation;
  if (revision(revisionContent) !== stored.revision) {
    throw new EffectRuntimeRequestError("stored outcome routing state revision does not match content");
  }
  return stored;
}

function requireBindings(value: unknown, projection: JsonObject): JsonObject[] {
  if (!Array.isArray(value)) {
    throw new EffectRuntimeRequestError("outcome routing Todo bindings must be an array");
  }
  const workItems = projection.work_items;
  if (!Array.isArray(workItems)) {
    throw new EffectRuntimeRequestError("stored outcome work_items must be an array");
  }
  const targets = new Map(workItems.map((value) => {
    const work = requireJsonObject(value, "stored outcome work item");
    return [
      requireNonEmptyString(work.work_item_id, "stored work_item_id"),
      requireNonEmptyString(work.target_key, "stored target_key"),
    ];
  }));
  const workIds = new Set<string>();
  const todoIds = new Set<string>();
  return value.map((value, index) => {
    const binding = requireJsonObject(value, `todo_bindings[${index}]`);
    const workItemId = requireNonEmptyString(binding.work_item_id, `todo_bindings[${index}].work_item_id`);
    const targetKey = requireNonEmptyString(binding.target_key, `todo_bindings[${index}].target_key`);
    const todoId = requireNonEmptyString(binding.todo_id, `todo_bindings[${index}].todo_id`);
    if (targets.get(workItemId) !== targetKey) {
      throw new EffectRuntimeRequestError("Todo binding must match a projected work item and target");
    }
    if (workIds.has(workItemId) || todoIds.has(todoId)) {
      throw new EffectRuntimeRequestError("Todo bindings must have unique work_item_id and todo_id values");
    }
    workIds.add(workItemId);
    todoIds.add(todoId);
    return {
      work_item_id: workItemId,
      target_key: targetKey,
      todo_id: todoId,
      role: requireStringLiteral(binding.role, ["agent", "user"] as const, `todo_bindings[${index}].role`),
    };
  });
}

async function readStoredState(path: string, goalId: string): Promise<JsonObject | null> {
  try {
    return decodeStoredState(JSON.parse(await readFile(path, "utf8")), goalId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadOutcomeRoutingState(value: unknown): Promise<JsonObject> {
  const { goalId, path } = storeRequest(value);
  return {
    schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA,
    operation: "load",
    goal_id: goalId,
    path,
    state: await readStoredState(path, goalId),
  };
}

export async function writeOutcomeRoutingState(value: unknown): Promise<JsonObject> {
  const { request, goalId, path } = storeRequest(value);
  const expectedRevision = optionalNonEmptyString(
    request.expected_revision,
    "expected_revision",
  );
  const projection = projectOutcomeRoutingPlan(request.state);
  return await withFileMutationLock(path, async () => {
    const existing = await readStoredState(path, goalId);
    if (existing && JSON.stringify(stableValue(existing.projection)) === JSON.stringify(stableValue(projection))) {
      return {
        schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA,
        operation: "write",
        goal_id: goalId,
        path,
        state: existing,
        written: false,
        replayed: true,
      };
    }
    if (existing && expectedRevision === null) {
      throw new EffectRuntimeConflictError(
        "expected_revision is required when outcome routing state already exists",
      );
    }
    if (expectedRevision !== (existing?.revision ?? null)) {
      throw new EffectRuntimeConflictError("outcome routing state revision changed");
    }
    const compatible = new Map((projection.work_items as JsonObject[]).map((item) => [
      String(item.work_item_id),
      { target_key: item.target_key, role: (item.todo_projection as JsonObject).role },
    ]));
    const retainedBindings = Array.isArray(existing?.todo_bindings)
      ? existing.todo_bindings.filter((value) => {
        const binding = requireJsonObject(value, "stored Todo binding");
        const next = compatible.get(String(binding.work_item_id));
        return next?.target_key === binding.target_key && next?.role === binding.role;
      })
      : [];
    const revisionContent: JsonObject = { projection };
    if (retainedBindings.length > 0) revisionContent.todo_bindings = retainedBindings;
    const nextRevision = revision(revisionContent);
    const stored: JsonObject = {
      schema_version: OUTCOME_ROUTING_STATE_STORE_SCHEMA,
      goal_id: goalId,
      revision: nextRevision,
      updated_at: requireNonEmptyString(request.updated_at, "updated_at"),
      ...revisionContent,
    };
    await atomicWriteJson(path, stored);
    const readback = await readStoredState(path, goalId);
    if (!readback || readback.revision !== nextRevision) {
      throw new Error("outcome routing state readback failed");
    }
    return {
      schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA,
      operation: "write",
      goal_id: goalId,
      path,
      state: readback,
      written: true,
      replayed: false,
    };
  });
}

export async function bindOutcomeRoutingTodos(value: unknown): Promise<JsonObject> {
  const request = requireJsonObject(value, "outcome_routing_state_bind params");
  if (request.schema_version !== OUTCOME_ROUTING_STATE_BIND_REQUEST_SCHEMA) {
    throw new EffectRuntimeRequestError("outcome routing Todo bind request schema mismatch");
  }
  const runtimeRoot = requireNonEmptyString(request.runtime_root, "runtime_root");
  const goalId = requireNonEmptyString(request.goal_id, "goal_id");
  const path = outcomeRoutingStatePath(runtimeRoot, goalId);
  const expectedRevision = requireNonEmptyString(request.expected_revision, "expected_revision");
  const updatedAt = requireNonEmptyString(request.updated_at, "updated_at");
  return await withFileMutationLock(path, async () => {
    const existing = await readStoredState(path, goalId);
    if (!existing) throw new EffectRuntimeRequestError("persisted outcome routing state does not exist");
    if (existing.revision !== expectedRevision) {
      throw new EffectRuntimeConflictError("outcome routing state revision changed");
    }
    const projection = requireJsonObject(existing.projection, "stored projection");
    const todoBindings = requireBindings(request.todo_bindings, projection);
    const revisionContent: JsonObject = { projection };
    if (todoBindings.length > 0) revisionContent.todo_bindings = todoBindings;
    if (existing.reconciliation !== undefined) {
      revisionContent.reconciliation = requireJsonObject(existing.reconciliation, "stored reconciliation");
    }
    const nextRevision = revision(revisionContent);
    if (nextRevision === existing.revision) {
      return { schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA, operation: "bind", goal_id: goalId, path, state: existing, written: false, replayed: true };
    }
    const nextState: JsonObject = { ...existing, ...revisionContent, revision: nextRevision, updated_at: updatedAt };
    await atomicWriteJson(path, nextState);
    const readback = await readStoredState(path, goalId);
    if (!readback || readback.revision !== nextRevision) throw new Error("outcome routing Todo binding readback failed");
    return { schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA, operation: "bind", goal_id: goalId, path, state: readback, written: true, replayed: false };
  });
}

export async function recordOutcomeRoutingFeedback(value: unknown): Promise<JsonObject> {
  const request = requireJsonObject(value, "outcome_routing_state_feedback params");
  if (request.schema_version !== OUTCOME_ROUTING_STATE_FEEDBACK_REQUEST_SCHEMA) {
    throw new EffectRuntimeRequestError("outcome routing feedback request schema mismatch");
  }
  const runtimeRoot = requireNonEmptyString(request.runtime_root, "runtime_root");
  const goalId = requireNonEmptyString(request.goal_id, "goal_id");
  const expectedRevision = requireNonEmptyString(request.expected_revision, "expected_revision");
  const updatedAt = requireNonEmptyString(request.updated_at, "updated_at");
  const execute = requireBoolean(request.execute, "execute");
  const path = outcomeRoutingStatePath(runtimeRoot, goalId);
  return await withFileMutationLock(path, async () => {
    const existing = await readStoredState(path, goalId);
    if (!existing) throw new EffectRuntimeRequestError("persisted outcome routing state does not exist");
    if (existing.revision !== expectedRevision) {
      throw new EffectRuntimeConflictError("outcome routing state revision changed");
    }
    const projection = requireJsonObject(existing.projection, "stored projection");
    const priorFeedback = Array.isArray(projection.feedback) ? projection.feedback : [];
    const incoming = requireJsonObject(request.feedback, "feedback");
    const feedbackId = requireNonEmptyString(incoming.feedback_id, "feedback.feedback_id");
    const duplicate = priorFeedback.find((item) =>
      requireJsonObject(item, "stored feedback").feedback_id === feedbackId
    );
    if (duplicate) {
      const { disposition: _disposition, ...prior } = requireJsonObject(duplicate, "stored feedback");
      const normalized = projectOutcomeRoutingPlan({
        schema_version: "outcome_routing_plan_request_v0",
        direction: projection.direction,
        cycle: projection.cycle,
        outcomes: projection.outcomes,
        work_items: projection.work_items,
        feedback: [incoming],
      });
      const candidate = (normalized.feedback as JsonObject[])[0];
      const { disposition: _candidateDisposition, ...comparable } = candidate;
      if (JSON.stringify(stableValue(prior)) !== JSON.stringify(stableValue(comparable))) {
        throw new EffectRuntimeConflictError("feedback_id already exists with different content");
      }
      return { schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA, operation: "record_feedback", goal_id: goalId, path, state: existing, written: false, replayed: true };
    }
    const nextProjection = projectOutcomeRoutingPlan({
      schema_version: "outcome_routing_plan_request_v0",
      direction: projection.direction,
      cycle: projection.cycle,
      outcomes: projection.outcomes,
      work_items: projection.work_items,
      feedback: [...priorFeedback, incoming],
    });
    const revisionContent: JsonObject = { projection: nextProjection };
    if (Array.isArray(existing.todo_bindings) && existing.todo_bindings.length > 0) {
      revisionContent.todo_bindings = existing.todo_bindings;
    }
    if (existing.reconciliation !== undefined) revisionContent.reconciliation = existing.reconciliation;
    const nextState: JsonObject = {
      ...existing,
      projection: nextProjection,
      revision: revision(revisionContent),
      updated_at: updatedAt,
    };
    if (!execute) {
      return { schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA, operation: "record_feedback", goal_id: goalId, path, dry_run: true, state: nextState, written: false, replayed: false };
    }
    await atomicWriteJson(path, nextState);
    const readback = await readStoredState(path, goalId);
    if (!readback || readback.revision !== nextState.revision) throw new Error("outcome routing feedback readback failed");
    return { schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA, operation: "record_feedback", goal_id: goalId, path, dry_run: false, state: readback, written: true, replayed: false };
  });
}

export async function ingestOutcomeRoutingInbox(value: unknown): Promise<JsonObject> {
  const request = requireJsonObject(value, "outcome_routing_state_inbox params");
  if (request.schema_version !== OUTCOME_ROUTING_STATE_INBOX_REQUEST_SCHEMA) {
    throw new EffectRuntimeRequestError("outcome routing inbox request schema mismatch");
  }
  const runtimeRoot = requireNonEmptyString(request.runtime_root, "runtime_root");
  const goalId = requireNonEmptyString(request.goal_id, "goal_id");
  const expectedRevision = requireNonEmptyString(request.expected_revision, "expected_revision");
  const updatedAt = requireNonEmptyString(request.updated_at, "updated_at");
  const execute = requireBoolean(request.execute, "execute");
  if (!Array.isArray(request.feedback_items) || request.feedback_items.length > 256) {
    throw new EffectRuntimeRequestError("feedback_items must be an array of at most 256 items");
  }
  const feedbackItems = request.feedback_items as unknown[];
  const path = outcomeRoutingStatePath(runtimeRoot, goalId);
  return await withFileMutationLock(path, async () => {
    const existing = await readStoredState(path, goalId);
    if (!existing) throw new EffectRuntimeRequestError("persisted outcome routing state does not exist");
    if (existing.revision !== expectedRevision) {
      throw new EffectRuntimeConflictError("outcome routing state revision changed");
    }
    const projection = requireJsonObject(existing.projection, "stored projection");
    const priorFeedback = Array.isArray(projection.feedback) ? projection.feedback : [];
    const incoming = feedbackItems.map((item, index) =>
      requireJsonObject(item, `feedback_items[${index}]`)
    );
    // Validate every file before writing any of them. The projected feedback IDs
    // are the durable per-source cursor, so a restarted importer can rescan safely.
    const normalized = projectOutcomeRoutingPlan({
      schema_version: "outcome_routing_plan_request_v0",
      direction: projection.direction,
      cycle: projection.cycle,
      outcomes: projection.outcomes,
      work_items: projection.work_items,
      feedback: incoming,
    }).feedback as JsonObject[];
    const priorById = new Map(priorFeedback.map((item) => {
      const feedback = requireJsonObject(item, "stored feedback");
      return [requireNonEmptyString(feedback.feedback_id, "stored feedback_id"), feedback];
    }));
    const fresh: JsonObject[] = [];
    const replayedIds: string[] = [];
    for (const feedback of normalized) {
      const feedbackId = String(feedback.feedback_id);
      const prior = priorById.get(feedbackId);
      if (!prior) {
        const { disposition: _disposition, ...requestFeedback } = feedback;
        fresh.push(requestFeedback);
        continue;
      }
      if (JSON.stringify(stableValue(prior)) !== JSON.stringify(stableValue(feedback))) {
        throw new EffectRuntimeConflictError("feedback_id already exists with different content");
      }
      replayedIds.push(feedbackId);
    }
    const result = { schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA,
      operation: "ingest_inbox", goal_id: goalId, path,
      ingested_feedback_ids: fresh.map((item) => String(item.feedback_id)),
      replayed_feedback_ids: replayedIds };
    if (fresh.length === 0) {
      return { ...result, dry_run: !execute, state: existing, written: false, replayed: true };
    }
    const nextProjection = projectOutcomeRoutingPlan({
      schema_version: "outcome_routing_plan_request_v0",
      direction: projection.direction,
      cycle: projection.cycle,
      outcomes: projection.outcomes,
      work_items: projection.work_items,
      feedback: [...priorFeedback, ...fresh],
    });
    const revisionContent: JsonObject = { projection: nextProjection };
    if (Array.isArray(existing.todo_bindings) && existing.todo_bindings.length > 0) {
      revisionContent.todo_bindings = existing.todo_bindings;
    }
    if (existing.reconciliation !== undefined) revisionContent.reconciliation = existing.reconciliation;
    const nextState: JsonObject = { ...existing, projection: nextProjection,
      revision: revision(revisionContent), updated_at: updatedAt };
    if (!execute) return { ...result, dry_run: true, state: nextState, written: false, replayed: false };
    await atomicWriteJson(path, nextState);
    const readback = await readStoredState(path, goalId);
    if (!readback || readback.revision !== nextState.revision) throw new Error("outcome routing inbox readback failed");
    return { ...result, dry_run: false, state: readback, written: true, replayed: false };
  });
}

function todoReconciliation(value: unknown, projection: JsonObject): JsonObject {
  const request = requireJsonObject(value, "outcome routing reconciliation");
  if (!Array.isArray(request.observations)) {
    throw new EffectRuntimeRequestError("outcome routing observations must be an array");
  }
  const workItems = projection.work_items;
  if (!Array.isArray(workItems)) {
    throw new EffectRuntimeRequestError("stored outcome work_items must be an array");
  }
  const byTarget = new Map<string, JsonObject>();
  for (const item of workItems) {
    const work = requireJsonObject(item, "stored outcome work item");
    const target = requireNonEmptyString(work.target_key, "stored work target_key");
    if (byTarget.has(target)) {
      throw new EffectRuntimeRequestError("stored outcome work target_key must be unique");
    }
    byTarget.set(target, work);
  }
  const seenTargets = new Set<string>();
  const observations = request.observations.map((value, index) => {
    const raw = requireJsonObject(value, `observations[${index}]`);
    const targetKey = requireNonEmptyString(raw.target_key, `observations[${index}].target_key`);
    if (seenTargets.has(targetKey)) {
      throw new EffectRuntimeRequestError("routed Todo observations must have unique target_key values");
    }
    seenTargets.add(targetKey);
    const work = byTarget.get(targetKey);
    if (!work) {
      throw new EffectRuntimeRequestError(
        `routed Todo observation target_key ${JSON.stringify(targetKey)} is unknown`,
      );
    }
    const todoStatus = requireStringLiteral(
      raw.status,
      ["open", "done", "blocked", "deferred"] as const,
      `observations[${index}].status`,
    );
    const evidenceRef = optionalNonEmptyString(
      raw.evidence_ref,
      `observations[${index}].evidence_ref`,
    );
    const priorStatus = requireNonEmptyString(work.status, "stored work status");
    const nextStatus = todoStatus === "done"
      ? (evidenceRef === null ? "awaiting_evidence" : "done")
      : todoStatus === "blocked"
        ? "replanning"
        : priorStatus;
    return {
      work_item_id: work.work_item_id,
      target_key: targetKey,
      todo_id: requireNonEmptyString(raw.todo_id, `observations[${index}].todo_id`),
      todo_status: todoStatus,
      prior_status: priorStatus,
      next_status: nextStatus,
      ...(evidenceRef === null ? {} : { evidence_ref: evidenceRef }),
      changed: priorStatus !== nextStatus,
    };
  });
  return {
    schema_version: OUTCOME_ROUTING_STATE_RECONCILIATION_SCHEMA,
    observations,
    replan_required: observations.some((item) =>
      item.next_status === "replanning" || item.next_status === "awaiting_evidence"
    ),
  };
}

export async function reconcileOutcomeRoutingState(value: unknown): Promise<JsonObject> {
  const request = requireJsonObject(value, "outcome_routing_state_reconcile params");
  if (request.schema_version !== OUTCOME_ROUTING_STATE_RECONCILE_REQUEST_SCHEMA) {
    throw new EffectRuntimeRequestError("outcome routing reconciliation request schema mismatch");
  }
  const runtimeRoot = requireNonEmptyString(request.runtime_root, "runtime_root");
  const goalId = requireNonEmptyString(request.goal_id, "goal_id");
  const path = outcomeRoutingStatePath(runtimeRoot, goalId);
  const expectedRevision = requireNonEmptyString(
    request.expected_revision,
    "expected_revision",
  );
  const execute = requireBoolean(request.execute, "execute");
  const updatedAt = requireNonEmptyString(request.updated_at, "updated_at");
  return await withFileMutationLock(path, async () => {
    const existing = await readStoredState(path, goalId);
    if (!existing) {
      throw new EffectRuntimeRequestError("persisted outcome routing state does not exist");
    }
    if (existing.revision !== expectedRevision) {
      throw new EffectRuntimeConflictError("outcome routing state revision changed");
    }
    const projection = requireJsonObject(existing.projection, "stored projection");
    const reconciliation = todoReconciliation(request, projection);
    const revisionContent: JsonObject = { projection, reconciliation };
    if (Array.isArray(existing.todo_bindings) && existing.todo_bindings.length > 0) {
      revisionContent.todo_bindings = existing.todo_bindings;
    }
    const nextRevision = revision(revisionContent);
    const nextState: JsonObject = {
      ...existing,
      revision: nextRevision,
      updated_at: updatedAt,
      reconciliation,
    };
    if (!execute) {
      return {
        schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA,
        operation: "reconcile",
        goal_id: goalId,
        path,
        dry_run: true,
        state: nextState,
        written: false,
        replayed: false,
      };
    }
    if (existing.revision === nextRevision) {
      return {
        schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA,
        operation: "reconcile",
        goal_id: goalId,
        path,
        dry_run: false,
        state: existing,
        written: false,
        replayed: true,
      };
    }
    await atomicWriteJson(path, nextState);
    const readback = await readStoredState(path, goalId);
    if (!readback || readback.revision !== nextRevision) {
      throw new Error("outcome routing reconciliation readback failed");
    }
    return {
      schema_version: OUTCOME_ROUTING_STATE_STORE_RESULT_SCHEMA,
      operation: "reconcile",
      goal_id: goalId,
      path,
      dry_run: false,
      state: readback,
      written: true,
      replayed: false,
    };
  });
}

export function planOutcomeRoutingNextCycle(value: unknown): JsonObject {
  const request = requireJsonObject(value, "outcome_routing_next_cycle params");
  if (request.schema_version !== OUTCOME_ROUTING_NEXT_CYCLE_REQUEST_SCHEMA) {
    throw new EffectRuntimeRequestError("outcome routing next-cycle request schema mismatch");
  }
  const goalId = requireNonEmptyString(request.goal_id, "goal_id");
  const stored = decodeStoredState(request.state, goalId);
  const projection = requireJsonObject(stored.projection, "stored projection");
  const reconciliation = stored.reconciliation === undefined
    ? null
    : requireJsonObject(stored.reconciliation, "stored reconciliation");
  const observations = reconciliation?.observations;
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new EffectRuntimeRequestError("outcome routing next cycle requires Todo reconciliation");
  }
  const byTarget = new Map<string, JsonObject>();
  for (const value of observations) {
    const observation = requireJsonObject(value, "reconciliation observation");
    byTarget.set(
      requireNonEmptyString(observation.target_key, "observation target_key"),
      observation,
    );
  }
  const workItems = projection.work_items;
  if (!Array.isArray(workItems)) {
    throw new EffectRuntimeRequestError("stored outcome work_items must be an array");
  }
  const nextWorkItems: JsonObject[] = [];
  const feedback: JsonObject[] = Array.isArray(projection.feedback)
    ? projection.feedback.map((item) => {
      const prior = requireJsonObject(item, "stored routing feedback");
      const { disposition: _disposition, ...requestFeedback } = prior;
      return requestFeedback;
    })
    : [];
  let convergedCount = 0;
  for (const value of workItems) {
    const work = requireJsonObject(value, "stored outcome work item");
    const targetKey = requireNonEmptyString(work.target_key, "stored work target_key");
    const observation = byTarget.get(targetKey);
    const nextStatus = observation?.next_status;
    if (nextStatus === "done") {
      const todoId = requireNonEmptyString(observation?.todo_id, "observation todo_id");
      convergedCount += 1;
      feedback.push({
        feedback_id: todoFeedbackId(
          requireNonEmptyString(work.work_item_id, "stored work work_item_id"),
          nextStatus,
          todoId,
          Number(projection.cycle),
        ),
        source: "loopx_todo",
        subject: `Todo completed: ${work.title}`,
        kind: "execution_result",
        observed_at: requireNonEmptyString(stored.updated_at, "stored updated_at"),
        evidence_ref: requireNonEmptyString(
          observation?.evidence_ref,
          "completion evidence_ref",
        ),
        affected_outcome_ids: [work.outcome_id],
      });
      continue;
    }
    const {
      route: _route,
      route_reason: _routeReason,
      status: _status,
      todo_projection: _todoProjection,
      ...nextWork
    } = work;
    nextWorkItems.push(nextWork);
    if (nextStatus === "replanning" || nextStatus === "awaiting_evidence") {
      const todoId = requireNonEmptyString(observation?.todo_id, "observation todo_id");
      feedback.push({
        feedback_id: todoFeedbackId(
          requireNonEmptyString(work.work_item_id, "stored work work_item_id"),
          nextStatus,
          todoId,
          Number(projection.cycle),
        ),
        source: "loopx_todo",
        subject: nextStatus === "replanning"
          ? `Todo blocked: ${work.title}`
          : `Todo completion needs evidence: ${work.title}`,
        kind: "risk",
        observed_at: requireNonEmptyString(stored.updated_at, "stored updated_at"),
        evidence_ref: `loopx-todo:${todoId}`,
        affected_outcome_ids: [work.outcome_id],
      });
    }
  }
  const nextState: JsonObject = {
    schema_version: "outcome_routing_plan_request_v0",
    direction: projection.direction,
    cycle: Number(projection.cycle) + 1,
    outcomes: projection.outcomes,
    work_items: nextWorkItems,
    feedback,
  };
  const nextProjection = projectOutcomeRoutingPlan(nextState);
  return {
    schema_version: OUTCOME_ROUTING_NEXT_CYCLE_SCHEMA,
    goal_id: goalId,
    source_revision: stored.revision,
    converged_work_item_count: convergedCount,
    remaining_work_item_count: nextWorkItems.length,
    goal_converged: nextWorkItems.length === 0,
    replan_required: nextProjection.replan_required,
    state: nextState,
    projection: nextProjection,
  };
}
