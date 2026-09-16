# Company Control Loop

The Company Control Loop is LoopX's provider-neutral planning layer for a
long-running company direction. It routes bounded work to AI or people, keeps
the result under one Goal, reconciles Todo evidence, and produces the next
planning cycle.

## Roadmap placement

This command is a bounded planning profile for the persistent steward path in
the [LoopX overall roadmap](../architecture/rfcs/loopx-overall-roadmap-v0.md),
primarily S1 and S3. It exercises existing Goal, Todo, evidence, quota, and
replan owners; it does not create a second steward, work ledger, scheduler, or
authority model. Its current acceptance boundary is the documented CLI and
packaged runtime lifecycle. The broader R2/R3 journey still requires real
multi-Agent adoption, dependent artifacts, independent acceptance, restart
recovery, and automatic result return through their existing owners.

## Authority boundary

The command does not grant execution authority. Existing LoopX Todo rules own
claims, user gates, leases, validation, and completion. The company layer owns
only these decisions:

- `ai_execute` becomes an agent advancement Todo.
- `human_decide` becomes a blocking user gate.
- `human_execute` becomes a user action.
- `observe` becomes a bounded continuous monitor.
- prohibited work becomes a blocker.

A Todo marked done is accepted only when reconciliation also receives an
evidence reference. Completion without evidence becomes `awaiting_evidence`;
a blocked Todo becomes `replanning`.

## State lifecycle

Start with a `outcome_routing_plan_request_v0` JSON object. It contains one
direction, a cycle number, outcomes, work items, and feedback.

`company-control-loop` is the product profile. Its control-plane contracts,
effect IDs, state directory, and schemas use the domain-neutral
`outcome_routing_*` family so the shared work-item kernel does not acquire
company-specific vocabulary.

```sh
loopx company-control-loop project --state-json company.json
loopx company-control-loop save \
  --goal-id company-goal \
  --state-json company.json
```

Both commands are read-only at this point. Add `--execute` to `save` after
review. Replacing existing state also requires the exact revision returned by
`show` or the prior write:

```sh
loopx company-control-loop save \
  --goal-id company-goal \
  --state-json company.json \
  --expected-revision REVISION \
  --execute

loopx company-control-loop show --goal-id company-goal
```

## Materialize work as Todos

Preview the idempotent plan first, then execute it:

```sh
loopx company-control-loop sync-todos \
  --goal-id company-goal \
  --agent-id company-ceo \
  --project /path/to/project

loopx company-control-loop sync-todos \
  --goal-id company-goal \
  --agent-id company-ceo \
  --project /path/to/project \
  --execute
```

The profile persists a revisioned `work_item_id` to `todo_id` binding after
Todo readback. Agent Todos may still use the kernel's existing `target_key`
identity. Human Todos remain ordinary `user_gate` and `user_action` records;
their correlation identity stays inside profile state. Failed readback or a
stale state revision stops the command.

## Reconcile and plan the next cycle

Reconciliation is also dry-run by default:

```sh
loopx company-control-loop reconcile-todos \
  --goal-id company-goal \
  --agent-id company-ceo \
  --project /path/to/project

loopx company-control-loop reconcile-todos \
  --goal-id company-goal \
  --agent-id company-ceo \
  --project /path/to/project \
  --execute

loopx company-control-loop next-cycle --goal-id company-goal
```

`next-cycle` returns a new request object. Evidence-backed completed work leaves
the active frontier. Failures and missing evidence become typed feedback and
set `replan_required`. When no work remains, `goal_converged` is true.

Review the returned state before saving it as the next cycle. Revision checks
prevent an older planner or restarted worker from overwriting newer state.

## Always-on operation

An always-on host should run the ordinary LoopX heartbeat contract. Each wake
must enter through `quota should-run`, advance only the selected Todo, validate
the result, write state, and spend the matching slot. Scheduler cadence and
human notification remain host responsibilities; this command does not create
an independent hidden scheduler.

The selected agent can use `tick` to run one bounded profile cycle. A preview
shows missing Todos without creating them; `--execute` creates missing Todos,
verifies their readback, reconciles current Todo evidence, and returns the next
cycle proposal. The returned plan is not saved automatically: AI or an owner
must inspect new feedback and adjust work before saving a new cycle with the
exact revision. This prevents an unattended tick from declaring acceptance or
overwriting a newer plan.

Observed work is materialized as a watch-only monitor with a 30-minute default
cadence, so the ordinary heartbeat can schedule it without creating another
scheduler.

```sh
loopx company-control-loop tick \
  --goal-id company-goal --agent-id company-ceo --project /path/to/project \
  --task-repository git:github.com/example/company
loopx company-control-loop tick \
  --goal-id company-goal --agent-id company-ceo --project /path/to/project \
  --task-repository git:github.com/example/company \
  --execute
```
