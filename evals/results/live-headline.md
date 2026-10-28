# Live headline evals (2026-10-28)

Real Meta and Baseten calls only (ledger providers meta/baseten); costs at Standard list price. Raw rows: `evals/results/live/`. Script: `scripts/live/headline.ts`.

## 1. Heal ladder on held-out drift (Caravela: every mutation operator, plus the v2 UI and the model-heal operators)
Seeds 101, 102, 103 (not used in development), 42 cases, compiled from a live first run. 42 correct, 0 false heals (silent wrong), must-fail-safe stopped 3/3, 0 failed without writing.

| Rung | Steps tried | Healed | Share | Cost per attempt | Latency per attempt |
|---|---|---|---|---|---|
| Free (fallback + similarity) | | 84 | | $0 | |
| 2: Muse Spark Open (Baseten, low) | 18 | 16 | 89% | $0.0029 | 2654 ms |
| 3: Muse Spark 1.3 computer use (low, ≤8 actions) | 2 | 2 | 100% | $0.0165 | 8910 ms |

Per operator (correct/cases): label_synonym 3/3, testid_churn 3/3, button_rename 6/6, reorder_fields 3/3, wrapper_divs 3/3, class_churn 3/3, id_churn 3/3, placeholder_change 3/3, insert_optional_field 3/3, insert_required_field 3/3, combobox_to_radio 6/6.

![heal rates](live-heal-rates.png)

## 2. Pure computer use vs compile once
Pure computer use: 8/8 correct, $0.1107 and 145.2 s per run. Compile once: first run $0.1667 (same task, loop build before the harness-click fix 5b2164a) + annotation $0.0113 (dry runs 2/2), then 50/50 replays correct with 0 model calls (3875 ms mean, randomized params, jittered latency), then 42 drift cases (42 correct or safe stop, $0.0843). Over 93 runs: $0.262 vs $10.296 (pure computer use projected from its measured mean after run 8). Break-even at run 2.

![cumulative cost](live-cu-vs-compile.png)

## 3. Video-guided vs goal-only first run
| Arm | Runs | Correct | Mean actions | Mean cost | Mean time |
|---|---|---|---|---|---|
| Video-guided (live Wonder teach draft), first 3 | 3 | 3 | 36.3 | $0.1198 | 152.5 s |
| Video-guided, all | 8 | 8 | 34.6 | $0.1107 | 145.2 s |
| Goal only (no steps) | 3 | 3 | 32.3 | $0.1181 | 124.5 s |
