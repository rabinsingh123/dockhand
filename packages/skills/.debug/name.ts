import { chromium } from "playwright";

const b = await chromium.launch();
const p = await b.newPage();
function f(): number {
  const inner = (x: number) => x + 1;
  return inner(1);
}
console.log("source:", f.toString().replace(/\s+/g, " ").slice(0, 160));
try {
  console.log("result:", await p.evaluate(f));
} catch (e) {
  console.log("error:", (e as Error).message.split("\n")[0]);
}
await b.close();
