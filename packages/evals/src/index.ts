// @dockhand/evals public API: bootstrap skills (no Meta model), case generation, one-case runner with ground
// truth from the portals' submission logs, summary math and charts. The CLI is src/cli.ts (`pnpm eval`).

export {
  canonicalActual,
  canonicalFromParam,
  canonicalFromText,
  expectedFields,
  type FieldBinding,
  fieldBindings,
} from "./bindings.ts";
export { type BootstrapDeps, bootstrapSkill, skillCachePath } from "./bootstrap.ts";
export { answerParamName, type GenerateOptions, generateCases, withRepAnswer } from "./cases.ts";
export {
  BUCKET_STYLE,
  type ChartMeta,
  costChartHtml,
  costModeOf,
  mutationChartHtml,
  renderChart,
  replayChartHtml,
} from "./charts.ts";
export { fixtureFile, isFileParam, materializeFiles } from "./files.ts";
export { createEvalLedger, type EvalLedger, providerLabel, type RunUsage } from "./ledger.ts";
export { evalsDbPath, evalsVarDir, resultsDir, skillCacheDir } from "./paths.ts";
export { EVAL_PORTALS, type EvalPortal, PORTALS, type PortalDef, portalDef } from "./portals.ts";
export {
  fakeElementPick,
  REPAIR_MODES,
  type RepairMode,
  type RepairSetup,
  repairSetup,
} from "./repairers.ts";
export {
  type EvalRecord,
  type Grade,
  gradeSubmissions,
  primarySelectorsOnly,
  type RecordedScript,
  type RunCaseDeps,
  runCase,
} from "./run.ts";
export {
  BUCKETS,
  type Bucket,
  bucketOf,
  type GroupSummary,
  headline,
  percentile,
  renderMarkdown,
  type Summary,
  summarize,
  summarizeGroup,
} from "./summary.ts";
