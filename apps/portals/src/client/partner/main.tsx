import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { BootPayload } from "../../shared/types.ts";
import { fetchBoot, initRuntime, injectCss, readInlineBoot } from "../runtime.ts";
import { BASE_CSS } from "../ui/baseCss.ts";
import { App } from "./App.tsx";
import { PARTNER_CSS } from "./css.ts";

function start(payload: BootPayload) {
  initRuntime(payload);
  injectCss(BASE_CSS + PARTNER_CSS);
  const el = document.getElementById("root");
  if (!el) throw new Error("#root missing");
  const root = createRoot(el);
  // Render synchronously so the page is complete before the load event (screenshots, replays).
  flushSync(() => root.render(<App />));
}

const inline = readInlineBoot();
if (inline) start(inline);
else void fetchBoot().then(start);
