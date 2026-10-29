// @dockhand/browser public API

export { isCommitTarget } from "./cu/commit.ts";
export { type KeyPlan, planKeys } from "./cu/keys.ts";
export { type RunComputerUseOptions, runComputerUse } from "./cu/loop.ts";
export { BLOCKED_PREFIX, computerUseFunctions, computerUseInstructions } from "./cu/prompt.ts";
export { DH_SCRIPT, ensureDh } from "./dom/script.ts";
export { describeAt, describeLocator } from "./helpers/describe.ts";
export { formSnapshot, listInteractive, readFieldValue } from "./helpers/forms.ts";
export {
  bareName,
  decoratedNameRegex,
  isStrongCandidate,
  type ToLocatorOptions,
  toLocator,
} from "./helpers/locators.ts";
export { type ResolveOptions, type ResolveResult, resolveTarget } from "./helpers/resolve.ts";
export { isSettled, SETTLED_MISS_MS, trackNetwork } from "./helpers/settle.ts";
export {
  FINGERPRINT_FLOOR,
  type InteractionClass,
  interactionClass,
  SIMILARITY_ACCEPT,
  SIMILARITY_MARGIN,
  similarity,
} from "./helpers/similarity.ts";
export { installWriteGuard, type WriteGuard } from "./helpers/writeGuard.ts";
export {
  attachHud,
  HUD_HIDE_CSS,
  HUD_SCRIPT,
  HUD_TAG,
  Hud,
  type HudOptions,
  hudOf,
  hudOptionsFromEnv,
  modelLabel,
} from "./hud/index.ts";
export { pngSize } from "./png.ts";
export {
  type BrowserPoolConfig,
  CONTEXT_DEFAULTS,
  closeBrowserOnSignals,
  createBrowserPool,
  type DockhandBrowserPool,
  launchArgs,
} from "./pool.ts";
export { type RenderOptions, renderHtml } from "./render.ts";
export {
  createScriptedModel,
  type ScriptedModel,
  type ScriptedModelOptions,
  semanticLocator,
} from "./scripted.ts";
