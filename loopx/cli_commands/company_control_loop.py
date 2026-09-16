from __future__ import annotations

import argparse
import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..control_plane.effect_runtime import effect_runtime_result
from ..todos import add_goal_todo, list_goal_todos


def register_company_control_loop_command(
    subparsers: argparse._SubParsersAction,
    add_subcommand_format: Callable[[argparse.ArgumentParser], None],
) -> None:
    parser = subparsers.add_parser(
        "company-control-loop",
        help="Validate and project a company planning snapshot into LoopX Todo lanes.",
    )
    add_subcommand_format(parser)
    actions = parser.add_subparsers(
        dest="company_control_loop_command",
        required=True,
    )
    project = actions.add_parser(
        "project",
        help="Project a outcome_routing_plan_request_v0 JSON object without writing state.",
    )
    add_subcommand_format(project)
    project.add_argument(
        "--state-json",
        required=True,
        help="Path to a outcome_routing_plan_request_v0 JSON object.",
    )
    save = actions.add_parser(
        "save",
        help="Validate and persist company control state under one Goal runtime.",
    )
    add_subcommand_format(save)
    save.add_argument("--goal-id", required=True, help="Goal that owns the company state.")
    save.add_argument(
        "--state-json",
        required=True,
        help="Path to a outcome_routing_plan_request_v0 JSON object.",
    )
    save.add_argument(
        "--expected-revision",
        help="Exact revision returned by show/save. Required to replace existing state.",
    )
    save.add_argument(
        "--execute",
        action="store_true",
        help="Persist the validated projection. Without this flag, return a preview.",
    )
    show = actions.add_parser(
        "show",
        help="Read the persisted company control state for one Goal.",
    )
    add_subcommand_format(show)
    show.add_argument("--goal-id", required=True, help="Goal that owns the company state.")
    sync = actions.add_parser(
        "sync-todos",
        help="Create missing LoopX Todos from persisted company work and verify readback.",
    )
    add_subcommand_format(sync)
    sync.add_argument(
        "--goal-id", required=True, help="Goal that owns the company state and Todos."
    )
    sync.add_argument(
        "--agent-id",
        required=True,
        help="Registered agent that owns routed agent work.",
    )
    sync.add_argument("--project", help="Project containing the Goal active state.")
    sync.add_argument(
        "--task-repository",
        help="Git repository identity assigned to routed agent work.",
    )
    sync.add_argument(
        "--execute",
        action="store_true",
        help="Create missing Todos. Without this flag, return the idempotent plan.",
    )
    reconcile = actions.add_parser(
        "reconcile-todos",
        help="Reconcile Todo status and evidence into persisted company state.",
    )
    add_subcommand_format(reconcile)
    reconcile.add_argument(
        "--goal-id", required=True, help="Goal that owns the company state and Todos."
    )
    reconcile.add_argument(
        "--agent-id",
        required=True,
        help="Registered agent whose routed Todo lane is reconciled.",
    )
    reconcile.add_argument("--project", help="Project containing the Goal active state.")
    reconcile.add_argument(
        "--execute",
        action="store_true",
        help="Persist reconciliation. Without this flag, return a preview.",
    )
    next_cycle = actions.add_parser(
        "next-cycle",
        help="Plan the next company cycle from reconciled Todo outcomes.",
    )
    add_subcommand_format(next_cycle)
    next_cycle.add_argument(
        "--goal-id", required=True, help="Goal that owns the reconciled company state."
    )
    tick = actions.add_parser(
        "tick",
        help="Project Todos, collect their evidence, and prepare the next planning cycle.",
    )
    add_subcommand_format(tick)
    tick.add_argument("--goal-id", required=True)
    tick.add_argument("--agent-id", required=True)
    tick.add_argument("--project", help="Project containing the Goal active state.")
    tick.add_argument(
        "--task-repository",
        help="Git repository identity assigned to routed agent work.",
    )
    tick.add_argument(
        "--execute",
        action="store_true",
        help="Persist Todo projection and reconciliation; leave the next plan for review.",
    )


def render_company_control_loop_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# LoopX Company Control Loop",
        "",
        f"- ok: `{payload.get('ok')}`",
    ]
    if payload.get("error"):
        lines.append(f"- error: {payload['error']}")
        return "\n".join(lines)
    lines.extend([
        f"- schema_version: `{payload.get('schema_version')}`",
        f"- direction: {payload.get('direction')}",
        f"- cycle: {payload.get('cycle')}",
        f"- replan_required: `{payload.get('replan_required')}`",
        "",
        "## Work routing",
        "",
    ])
    work_items = payload.get("work_items")
    if not isinstance(work_items, list) or not work_items:
        lines.append("- No work items.")
    else:
        for item in work_items:
            if isinstance(item, dict):
                lines.append(
                    f"- `{item.get('work_item_id')}` -> `{item.get('route')}` "
                    f"({item.get('status')}): {item.get('title')}"
                )
    return "\n".join(lines)


def _read_json_object(path_text: str) -> dict[str, Any]:
    payload = json.loads(Path(path_text).expanduser().read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise TypeError("company control state JSON must contain an object")
    return payload


def handle_company_control_loop_command(
    args: argparse.Namespace,
    *,
    output_format: Callable[..., str],
    print_payload: Callable[[dict[str, Any], str, Callable[[dict[str, Any]], str]], None],
    runtime_root: Path | None = None,
    registry_path: Path | None = None,
) -> int | None:
    if args.command != "company-control-loop":
        return None
    try:
        command = args.company_control_loop_command
        if command in {"show", "sync-todos", "reconcile-todos", "next-cycle", "tick"}:
            if runtime_root is None:
                raise ValueError("company control state requires a runtime root")
            projection = effect_runtime_result(
                "work_item.outcome_routing_state.load",
                {
                    "schema_version": "outcome_routing_state_store_request_v0",
                    "runtime_root": str(runtime_root),
                    "goal_id": args.goal_id,
                },
            )
            if command == "show":
                payload = {"ok": True, **projection}
            elif command == "next-cycle":
                payload = {
                    "ok": True,
                    **effect_runtime_result(
                        "work_item.outcome_routing_state.next_cycle",
                        {
                            "schema_version": "outcome_routing_next_cycle_request_v0",
                            "goal_id": args.goal_id,
                            "state": projection.get("state"),
                        },
                    ),
                }
            elif command == "sync-todos":
                if registry_path is None:
                    raise ValueError("company Todo sync requires a registry")
                payload = _sync_todos(
                    stored=projection,
                    goal_id=args.goal_id,
                    agent_id=args.agent_id,
                    project=Path(args.project).expanduser() if args.project else None,
                    registry_path=registry_path,
                    runtime_root=runtime_root,
                    task_repository=args.task_repository,
                    execute=bool(args.execute),
                )
            elif command == "tick":
                if registry_path is None:
                    raise ValueError("company tick requires a registry")
                payload = _tick(
                    stored=projection,
                    goal_id=args.goal_id,
                    agent_id=args.agent_id,
                    project=Path(args.project).expanduser() if args.project else None,
                    registry_path=registry_path,
                    runtime_root=runtime_root,
                    task_repository=args.task_repository,
                    execute=bool(args.execute),
                )
            else:
                if registry_path is None:
                    raise ValueError("company Todo reconciliation requires a registry")
                payload = _reconcile_todos(
                    stored=projection,
                    goal_id=args.goal_id,
                    agent_id=args.agent_id,
                    project=Path(args.project).expanduser() if args.project else None,
                    registry_path=registry_path,
                    runtime_root=runtime_root,
                    execute=bool(args.execute),
                )
        else:
            request = _read_json_object(args.state_json)
            projection = effect_runtime_result(
                "work_item.outcome_routing_plan.project",
                request,
            )
            if command != "save":
                payload = {"ok": True, **projection}
            else:
                if not args.execute:
                    payload = {
                        "ok": True,
                        "dry_run": True,
                        "goal_id": args.goal_id,
                        "projection": projection,
                    }
                else:
                    if runtime_root is None:
                        raise ValueError("company control state requires a runtime root")
                    write_request: dict[str, Any] = {
                        "schema_version": "outcome_routing_state_store_request_v0",
                        "runtime_root": str(runtime_root),
                        "goal_id": args.goal_id,
                        "state": request,
                        "updated_at": datetime.now(UTC).isoformat(),
                    }
                    if args.expected_revision:
                        write_request["expected_revision"] = args.expected_revision
                    saved = effect_runtime_result(
                        "work_item.outcome_routing_state.write",
                        write_request,
                    )
                    payload = {"ok": True, "dry_run": False, **saved}
        exit_code = 0
    except Exception as exc:
        payload = {"ok": False, "error": str(exc)}
        exit_code = 1
    print_payload(
        payload,
        output_format(args),
        render_company_control_loop_markdown,
    )
    return exit_code


def _tick(
    *,
    stored: dict[str, Any],
    goal_id: str,
    agent_id: str,
    project: Path | None,
    registry_path: Path,
    runtime_root: Path,
    task_repository: str | None,
    execute: bool,
) -> dict[str, Any]:
    sync = _sync_todos(
        stored=stored,
        goal_id=goal_id,
        agent_id=agent_id,
        project=project,
        registry_path=registry_path,
        runtime_root=runtime_root,
        task_repository=task_repository,
        execute=execute,
    )
    if not execute and any(action["action"] == "would_create" for action in sync["actions"]):
        return {
            "ok": True,
            "dry_run": True,
            "goal_id": goal_id,
            "phase": "todo_projection_preview",
            "sync": sync,
            "reconciliation": None,
            "next_cycle": None,
        }
    current = effect_runtime_result(
        "work_item.outcome_routing_state.load",
        {
            "schema_version": "outcome_routing_state_store_request_v0",
            "runtime_root": str(runtime_root),
            "goal_id": goal_id,
        },
    ) if execute else stored
    reconciliation = _reconcile_todos(
        stored=current,
        goal_id=goal_id,
        agent_id=agent_id,
        project=project,
        registry_path=registry_path,
        runtime_root=runtime_root,
        execute=execute,
    )
    state = reconciliation.get("state")
    if not isinstance(state, dict):
        raise RuntimeError("outcome routing reconciliation did not return state")
    next_cycle = effect_runtime_result(
        "work_item.outcome_routing_state.next_cycle",
        {
            "schema_version": "outcome_routing_next_cycle_request_v0",
            "goal_id": goal_id,
            "state": state,
        },
    )
    return {
        "ok": True,
        "dry_run": not execute,
        "goal_id": goal_id,
        "phase": "next_cycle_ready",
        "sync": sync,
        "reconciliation": reconciliation,
        "next_cycle": next_cycle,
    }


def _sync_todos(
    *,
    stored: dict[str, Any],
    goal_id: str,
    agent_id: str,
    project: Path | None,
    registry_path: Path,
    runtime_root: Path,
    task_repository: str | None,
    execute: bool,
) -> dict[str, Any]:
    state = stored.get("state")
    if not isinstance(state, dict):
        raise ValueError("persisted company control state does not exist")
    company = state.get("projection")
    if not isinstance(company, dict):
        raise TypeError("persisted company control projection is invalid")
    work_items = company.get("work_items")
    if not isinstance(work_items, list):
        raise TypeError("persisted company work_items must be an array")
    listing = list_goal_todos(
        registry_path=registry_path,
        runtime_root_arg=str(runtime_root),
        goal_id=goal_id,
        agent_id=agent_id,
        project=project,
        limit=500,
    )
    todos = [item for item in listing.get("todos", []) if isinstance(item, dict)]
    by_id = {
        str(todo.get("todo_id")): todo
        for todo in todos
        if todo.get("todo_id")
    }
    by_target: dict[str, dict[str, Any]] = {}
    for todo in todos:
        target = str(todo.get("target_key") or "").strip()
        if not target:
            continue
        if target in by_target:
            raise ValueError(f"multiple LoopX Todos use target_key {target!r}")
        by_target[target] = todo
    stored_bindings = {
        str(binding.get("work_item_id")): binding
        for binding in state.get("todo_bindings", [])
        if isinstance(binding, dict) and binding.get("work_item_id")
    }
    actions: list[dict[str, Any]] = []
    seen_targets: set[str] = set()
    for raw in work_items:
        if not isinstance(raw, dict):
            raise TypeError("persisted company work item is invalid")
        todo_projection = raw.get("todo_projection")
        if not isinstance(todo_projection, dict):
            raise TypeError("persisted company Todo projection is invalid")
        target = str(todo_projection.get("target_key") or "").strip()
        if not target or target in seen_targets:
            raise ValueError("company work target_key must be present and unique")
        seen_targets.add(target)
        binding = stored_bindings.get(str(raw.get("work_item_id")))
        matched = by_id.get(str(binding.get("todo_id"))) if binding else None
        if matched is None and todo_projection.get("role") == "agent":
            matched = by_target.get(target)
        if matched:
            actions.append({
                "work_item_id": raw.get("work_item_id"),
                "target_key": target,
                "action": "linked_existing",
                "todo_id": matched.get("todo_id"),
            })
            continue
        action: dict[str, Any] = {
            "work_item_id": raw.get("work_item_id"),
            "target_key": target,
            "action": "would_create",
            "role": todo_projection.get("role"),
            "task_class": todo_projection.get("task_class"),
        }
        if execute:
            role = str(todo_projection.get("role") or "")
            task_class = str(todo_projection.get("task_class") or "")
            monitor_metadata: dict[str, Any] = {}
            if role == "agent":
                monitor_metadata["target_key"] = target
            if task_class == "continuous_monitor":
                monitor_metadata["watch_only"] = "true"
                monitor_metadata["cadence"] = "30m"
            created = add_goal_todo(
                registry_path=registry_path,
                runtime_root_arg=str(runtime_root),
                goal_id=goal_id,
                project=project,
                role=role,
                text=f"[P1] {todo_projection.get('text')}",
                status="open",
                note=f"Acceptance: {todo_projection.get('acceptance')}",
                task_class=task_class,
                action_kind=str(todo_projection.get("action_kind") or ""),
                task_repository=task_repository if role == "agent" else None,
                claimed_by=agent_id if role == "agent" else None,
                agent_id=agent_id,
                blocks_agent=agent_id if task_class == "user_gate" else None,
                bound_agent=agent_id if task_class == "user_action" else None,
                decision_scope=(
                    f"direction:action:{target}"
                    if task_class == "user_gate"
                    else None
                ),
                monitor_metadata=monitor_metadata,
            )
            action["action"] = "created"
            action["todo_id"] = created.get("todo_id")
        actions.append(action)
    if execute:
        readback = list_goal_todos(
            registry_path=registry_path,
            runtime_root_arg=str(runtime_root),
            goal_id=goal_id,
            agent_id=agent_id,
            project=project,
            limit=500,
        )
        readback_by_id = {
            str(item.get("todo_id")): item
            for item in readback.get("todos", [])
            if isinstance(item, dict) and item.get("todo_id")
        }
        missing = sorted(
            str(action.get("todo_id"))
            for action in actions
            if str(action.get("todo_id")) not in readback_by_id
        )
        if missing:
            raise RuntimeError(f"LoopX Todo readback missing ids: {missing}")
        binding_result = effect_runtime_result(
            "work_item.outcome_routing_state.bind",
            {
                "schema_version": "outcome_routing_state_bind_request_v0",
                "runtime_root": str(runtime_root),
                "goal_id": goal_id,
                "expected_revision": state.get("revision"),
                "updated_at": datetime.now(UTC).isoformat(),
                "todo_bindings": [
                    {
                        "work_item_id": action["work_item_id"],
                        "target_key": action["target_key"],
                        "todo_id": action["todo_id"],
                        "role": action.get("role") or next(
                            str(item["todo_projection"].get("role"))
                            for item in work_items
                            if isinstance(item, dict)
                            and item.get("work_item_id") == action["work_item_id"]
                            and isinstance(item.get("todo_projection"), dict)
                        ),
                    }
                    for action in actions
                ],
            },
        )
        state = binding_result.get("state", state)
    return {
        "ok": True,
        "dry_run": not execute,
        "goal_id": goal_id,
        "state_revision": state.get("revision"),
        "actions": actions,
        "readback_verified": execute,
    }


def _reconcile_todos(
    *,
    stored: dict[str, Any],
    goal_id: str,
    agent_id: str,
    project: Path | None,
    registry_path: Path,
    runtime_root: Path,
    execute: bool,
) -> dict[str, Any]:
    state = stored.get("state")
    if not isinstance(state, dict):
        raise ValueError("persisted company control state does not exist")
    company = state.get("projection")
    if not isinstance(company, dict):
        raise TypeError("persisted company control projection is invalid")
    work_items = company.get("work_items")
    if not isinstance(work_items, list):
        raise TypeError("persisted company work_items must be an array")
    bindings = [item for item in state.get("todo_bindings", []) if isinstance(item, dict)]
    if not bindings:
        raise ValueError("persisted outcome routing state has no Todo bindings; run sync-todos first")
    bindings_by_todo = {
        str(item.get("todo_id")): item
        for item in bindings
        if item.get("todo_id")
    }
    listing = list_goal_todos(
        registry_path=registry_path,
        runtime_root_arg=str(runtime_root),
        goal_id=goal_id,
        agent_id=agent_id,
        project=project,
        limit=500,
    )
    observations: list[dict[str, Any]] = []
    seen_targets: set[str] = set()
    for raw in listing.get("todos", []):
        if not isinstance(raw, dict):
            continue
        binding = bindings_by_todo.get(str(raw.get("todo_id") or ""))
        if binding is None:
            continue
        target = str(binding.get("target_key") or "").strip()
        if target in seen_targets:
            raise ValueError(f"multiple LoopX Todos use target_key {target!r}")
        seen_targets.add(target)
        observation: dict[str, Any] = {
            "target_key": target,
            "todo_id": raw.get("todo_id"),
            "status": raw.get("status"),
        }
        evidence = raw.get("evidence")
        if raw.get("status") == "done" and not (
            isinstance(evidence, str) and evidence.strip()
        ):
            todo_id = str(raw.get("todo_id") or "").strip()
            detail = list_goal_todos(
                registry_path=registry_path,
                runtime_root_arg=str(runtime_root),
                goal_id=goal_id,
                todo_id=todo_id,
                agent_id=agent_id,
                project=project,
            )
            matched = [
                item for item in detail.get("todos", [])
                if isinstance(item, dict) and item.get("todo_id") == todo_id
            ]
            if len(matched) == 1:
                evidence = matched[0].get("evidence")
        if isinstance(evidence, str) and evidence.strip():
            observation["evidence_ref"] = evidence.strip()
        observations.append(observation)
    if not observations:
        raise ValueError("no LoopX Todos match persisted outcome routing bindings")
    result = effect_runtime_result(
        "work_item.outcome_routing_state.reconcile",
        {
            "schema_version": "outcome_routing_state_reconcile_request_v0",
            "runtime_root": str(runtime_root),
            "goal_id": goal_id,
            "expected_revision": state.get("revision"),
            "updated_at": datetime.now(UTC).isoformat(),
            "execute": execute,
            "observations": observations,
        },
    )
    return {"ok": True, **result}
