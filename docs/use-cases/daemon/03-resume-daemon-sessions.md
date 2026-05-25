# UC-DAEMON-03: Resume Work Across Daemon Stop and Start

> Grovie treats the daemon as a local supervisor, so stopping or restarting it should not make resumable session work disappear.

## Rules

| ID | Rule |
|----|------|
| R1 | A Grovie run records one execution attempt; daemon recovery creates a new run in the same session instead of rewriting the old run. |
| R2 | Interrupted runs are distinct from failed and user-canceled runs. |

## Scenarios

| ID | Priority | Scenario |
|----|----------|----------|
| UC-DAEMON-03-S01 | P0 | Graceful daemon stop marks active runs interrupted and resumable before terminating the daemon process. |
| UC-DAEMON-03-S02 | P0 | Daemon start resumes interrupted sessions before polling new queue items by creating a new resume run while the source run remains interrupted. |
| UC-DAEMON-03-S03 | P0 | Daemon start recovers active-looking runs left behind by a force stop or crash. |
| UC-DAEMON-03-S04 | P0 | User-canceled runs are not auto-resumed. |
| UC-DAEMON-03-S05 | P0 | Failed runs are not auto-resumed without an explicit retry or rerun request. |
