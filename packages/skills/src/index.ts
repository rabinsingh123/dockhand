// @dockhand/skills public API: templates, compiler, annotation, runner, repairers, canary, diff, export, store.

export {
  type AnnotateReport,
  annotateSkill,
  annotateSkillDetailed,
  applyAnnotation,
  applyRenames,
  referencedParams,
  SkillAnnotation,
} from "./annotate.ts";
export { type CanaryFailure, type CanaryOptions, type CanaryResult, runCanary } from "./canary.ts";
export {
  type CompileMeta,
  type CompileResult,
  compile,
  DEFAULT_ID_NAME,
  generalizeId,
  playwrightKey,
  rebaseSkill,
  slotParamName,
} from "./compile.ts";
export { type DiffableSkill, diffSkills, type StepNote } from "./diff.ts";
export { exportPlaywright } from "./export.ts";
export {
  type CuRepairerOptions,
  createCuRepairer,
  createOpenWeightsRepairer,
  ElementPick,
} from "./repair.ts";
export { type RunEnv, type RunSkillOptions, runSkill } from "./runner.ts";
export { createSkillStore } from "./store.ts";
export {
  defaultIntent,
  displayName,
  interactionClass,
  isCommitStep,
  stepTarget,
} from "./targets.ts";
export {
  DATE_FORMATS,
  matchValue,
  NUMBER_LOCALES,
  normalizeText,
  parseTemplate,
  renderRegexTemplate,
  renderTemplate,
  renderUrlTemplate,
  type TemplatedValue,
  type TemplateFilter,
  templateParams,
  templateUrl,
  templateValue,
  type ValueBinding,
  valuesEquivalent,
} from "./template.ts";
