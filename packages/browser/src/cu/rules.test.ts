import { createMemoryArtifactStore } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import type { CommitInfo } from "../dom/script.ts";
import { isCommitTarget, keyCommitTarget } from "./commit.ts";
import { planKeys } from "./keys.ts";
import { computerUseFunctions, computerUseInstructions } from "./prompt.ts";

describe("planKeys", () => {
  it.each([
    [["Enter"], ["Enter"], true],
    [["ENTER"], ["Enter"], true],
    [["Return"], ["Enter"], true],
    [["ctrl", "a"], ["Control+a"], false],
    [["CTRL+A"], ["Control+a"], false],
    [["cmd", "a"], ["ControlOrMeta+a"], false],
    [["meta+v"], ["ControlOrMeta+v"], false],
    [["Tab"], ["Tab"], false],
    [["shift", "tab"], ["Shift+Tab"], false],
    [["up"], ["ArrowUp"], false],
    [["ArrowDown"], ["ArrowDown"], false],
    [["esc"], ["Escape"], false],
    [["pgdn"], ["PageDown"], false],
    [["Tab", "Tab"], ["Tab", "Tab"], false],
    [["alt", "f4"], ["Alt+F4"], false],
    [["space"], ["Space"], false],
  ])("%j -> %j", (keys, chords, enter) => {
    const plan = planKeys(keys);
    expect(plan.chords).toEqual(chords);
    expect(plan.enter).toBe(enter);
  });
  it("flags Space separately (it activates a focused button)", () => {
    expect(planKeys([" "]).space).toBe(true);
  });
});

describe("isCommitTarget", () => {
  const button = (name: string, extra: Partial<CommitInfo> = {}): CommitInfo => ({
    tag: "button",
    name,
    buttonLike: true,
    link: false,
    submitType: false,
    inForm: true,
    inDialog: false,
    box: { x: 0, y: 0, w: 10, h: 10 },
    ...extra,
  });
  it.each([
    ["Submit registration", {}, 0, true],
    ["Register opportunity", {}, 0, true],
    ["Enviar cadastro", {}, 0, true],
    ["Concluir", {}, 0, true],
    ["Next", { submitType: true }, 3, false],
    ["Sign in", { submitType: true }, 2, false],
    ["Save", { submitType: true }, 2, true], // submit-type, not navigation: bias to block
    ["Cancel", {}, 2, false],
    ["Submit for approval", { inForm: false }, 0, true], // supplier review step: not in a form
    ["Register a deal", { inForm: false }, 0, false], // list page entry point
    ["Register a deal", { inForm: false }, 3, true], // ... but not once something was entered
    ["Confirm", { inForm: false, inDialog: true }, 0, true],
  ] as const)("%s %j filled=%d -> %s", (name, extra, filled, expected) => {
    expect(isCommitTarget(button(name, extra), filled, [])).toBe(expected);
  });
  it("treats any control named in commitHints as commit, links included", () => {
    expect(
      isCommitTarget(button("Send it *", { buttonLike: false, link: true, inForm: false }), 0, ["Send it"]),
    ).toBe(true);
    expect(isCommitTarget(button("Open report", { buttonLike: false, link: true }), 3, [])).toBe(false);
  });
  it("judges Enter by the focused field's form default button, and never in a textarea or open listbox", () => {
    const def = button("Submit registration", { submitType: true });
    expect(keyCommitTarget({ kind: "field", def, filled: 2 }, "enter", [])).toBe(def);
    expect(
      keyCommitTarget({ kind: "field", def: button("Next", { submitType: true }), filled: 2 }, "enter", []),
    ).toBeNull();
    expect(keyCommitTarget({ kind: "field", def, filled: 2 }, "space", [])).toBeNull();
    expect(keyCommitTarget({ kind: "multiline", filled: 2 }, "enter", [])).toBeNull();
    expect(keyCommitTarget({ kind: "listbox", filled: 2 }, "enter", [])).toBeNull();
    expect(keyCommitTarget({ kind: "button", self: def, filled: 2 }, "space", [])).toBe(def);
  });
});

describe("computer-use instructions", () => {
  const base = {
    portalId: "caravela",
    goal: "Register the Sabiá Foods deal",
    guidance: ["Fill End customer company with {company}", "Choose the country {country}"],
    params: { company: "Sabiá Foods Ltda.", country: "Brazil", seats: 25 },
    attachments: {},
    commitPolicy: "gate" as const,
  };
  it("lists only the run's values and states the gate, upload and infeasibility rules", () => {
    const text = computerUseInstructions(base);
    expect(text).toContain("- company: Sabiá Foods Ltda.");
    expect(text).toContain("- seats: 25");
    expect(text).toMatch(/never use values remembered/);
    expect(text).toMatch(/call request_commit/);
    expect(text).toMatch(/attach_file/);
    expect(text).toMatch(/starts with "BLOCKED:"/);
    expect(text).toMatch(/Never claim the task is done without proof on screen/);
    expect(text).toContain("1. Fill End customer company with {company}");
    expect(computerUseFunctions(base).map((f) => f.name)).toEqual(["request_commit"]);
  });
  it("in propose_only mode asks for propose_target instead of clicking, and offers attach_file slots", async () => {
    const artifacts = createMemoryArtifactStore();
    const w9 = await artifacts.put(new Uint8Array([1]), "application/pdf", { kind: "upload_fixture" });
    const input = {
      ...base,
      commitPolicy: "propose_only" as const,
      attachments: { w9 },
      params: { w9_file: { file: w9, filename: "w9.pdf" } },
    };
    const text = computerUseInstructions(input);
    expect(text).toMatch(/call propose_target/);
    expect(text).not.toMatch(/call request_commit/);
    expect(text).toContain('- w9_file: the file "w9.pdf" (attach it with attach_file, slot "w9")');
    expect(computerUseFunctions(input).map((f) => f.name)).toEqual(["propose_target", "attach_file"]);
  });
});
