# Repo health — .claude/outbox/repohealth.md

A colleague who reads `git log` so you do not have to. One section per day,
oldest first; a line is added under its day and never rewritten. A day on
which nothing moved leaves no line here at all — the silence is the reading.

Every entry is a value, the value it is read against, its percentile rank
within its own trailing window, and a slope sign. A rank is a position among
the READINGS in that window — day-rows, not calendar days, and a repo is not
worked on every day — so each rank names the day its window starts, because
a window of N readings and a window of N days are not the same span.
There is no threshold in here and nothing in here applies itself.

## 2026-10-22

- dialogs.mjs is now the longest file at 694 lines, past scripts/probe.mjs at 537 on 2026-10-21; p95 537.

## 2026-11-01

- the import-graph reading has none today: only 0 of 1 imports of this tree's own code resolved to a module (needs 90%); unresolved: `../test/twins.mjs` — an alias the bundler knows and tsconfig "paths" does not declare reads like this. It read on 2026-10-31, the last of 9 readings carrying one out of 10 readings in the series.
