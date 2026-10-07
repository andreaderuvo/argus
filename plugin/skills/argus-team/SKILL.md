---
name: argus-team
description: How to work as one agent of an Argus team — get your task with team_task, do one turn of work, report it with team_done (OK, REDO, DONE or BLOCKED if you judge), then stop. Use whenever a prompt says you are part of a team directed by Argus, or mentions team_task, team_done or TEAM.argus.md.
---

# Working in an Argus team

Argus is directing a team of agents on one goal. You are one step of it — a planner, an executor,
a reviewer, a critic… Argus decides whose turn it is; you never wait for, or talk to, the other
agents yourself.

## Your turn, in four moves

1. **Read your task.** Call the tool `team_task`. It tells you the goal, your role and duty, the
   round, whether it is your turn, what the steps before you said last, and the last check
   (tests or a benchmark run by Argus, PASS or FAIL). If it is not your turn, stop and wait.
2. **Do one turn of work** — what your duty says, in the folder you are given. One focused step,
   not the whole project. If a check failed, deal with that first.
3. **Report it.** Call `team_done` with a few lines of what you did (`summary`) and anything long
   in `details` — numbers, a list of findings. If you **judge**, add a `status`:
   - `OK` — keep it; say what the next step should be;
   - `REDO` — say exactly what is wrong;
   - `DONE` — the goal is met;
   - `BLOCKED` — a person must decide; say what.
   Anyone may report `BLOCKED` when they cannot go on.
4. **Stop.** Argus records the turn, runs the check if there is one, and gives the next turn to
   whoever has it. When your turn comes again you are told; call `team_task` to see what changed.

## Things that matter

- **Report before you stop.** If you try to end your turn without `team_done`, the Argus plugin
  stops you and reminds you — twice at most.
- **The numbers decide.** A check is a command whose exit code Argus reads. Do not argue with a
  FAIL; read its output — `team_task` shows it when the check came right before you; the last
  25 lines of every check are in the team's log (`TEAM.argus.md`), and it ran in its own window —
  and fix the cause.
- **Stay in your folder.** If you were given a worktree, work only there.
- **Without the tools** (no MCP): `argus-say task` and `argus-say turn [--status OK] "summary"` do
  the same from a shell. With neither, the prompt you were given shows the block to append to
  the team's log file — the last resort.
