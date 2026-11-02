// @dockhand/design: tokens, fonts and components for every surface Dockhand draws. docs/DESIGN.md is the guide;
// var/design/system.png is the rendered reference sheet (assets/video/design.ts draws it).

export {
  type Change,
  COMPONENT_CSS,
  changes,
  esc,
  FIT_SCRIPT,
  facts,
  foot,
  kicker,
  lockup,
  MARK,
  mark,
  PALETTE,
  proof,
  stage,
  state,
  sub,
  TELLS,
  tells,
  top,
} from "./components.ts";
export { FONT_FILES, fontBytes, fontFaceCss } from "./fonts.ts";
export { referenceSheetHtml } from "./reference.ts";
export { COLOR, cssVariables, GRID, MOTION, RADIUS, RULE, SPACE, space, TOKENS, TYPE } from "./tokens.ts";

import { COMPONENT_CSS } from "./components.ts";
import { fontFaceCss } from "./fonts.ts";
import { cssVariables } from "./tokens.ts";

/** Everything a self-contained `ui`-scale page needs in its <style>: fonts inlined, tokens, components. */
export function uiCss(): string {
  return fontFaceCss() + cssVariables("ui") + COMPONENT_CSS;
}
