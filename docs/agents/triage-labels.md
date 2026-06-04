# Triage Labels

Triage uses **two role dimensions**: a **category** role and a **state** role.
Every triaged issue carries exactly one of each. Since issues are local markdown
under `.scratch/<feature>/`, roles are recorded as lines near the top of an issue
file — there are no GitHub labels. These tables map each canonical role to the
string this repo uses.

## State roles — recorded as a `Status:` line

| Canonical role    | `Status:` string in our files | Meaning                                  |
| ----------------- | ----------------------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`                | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`                  | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent`             | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human`             | Requires human implementation            |
| `wontfix`         | `wontfix`                     | Will not be actioned                     |

## Category roles — recorded as a `Category:` line

| Canonical role | `Category:` string in our files | Meaning                     |
| -------------- | ------------------------------- | --------------------------- |
| `bug`          | `bug`                           | Something is broken         |
| `enhancement`  | `enhancement`                   | New feature or improvement  |

## Parent `PRD.md` files

A feature's `PRD.md` is a **parent spec**, not an agent-grabbable issue. It carries
a `Category:` role but **no agent state** — triage state lives on its child issues
under `issues/`. Record its state line as `Status: parent-spec` to keep it out of
the agent state machine.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), write the
corresponding string as the issue's `Status:` / `Category:` line. Edit the
right-hand columns if you later adopt a different vocabulary.
