import { describe, expect, it } from "vitest";
import { approveIfLocal } from "./portals.ts";

describe("approveIfLocal (evals and dev scripts)", () => {
  it("approves only while the page is on a local origin", () => {
    const at = (url: string) => ({ url: () => url });
    expect(approveIfLocal(at("http://127.0.0.1:5101/deals/new"))).toBe("approved");
    expect(approveIfLocal(at("http://localhost:8080/#Lead/create"))).toBe("approved");
    expect(approveIfLocal(at("http://[::1]:5102/t/acme"))).toBe("approved");
    expect(approveIfLocal(at("https://crm.example.com/#Lead/create"))).toBe("rejected");
    expect(approveIfLocal(at("http://127.0.0.1.evil.example/"))).toBe("rejected");
    expect(approveIfLocal(at("about:blank"))).toBe("rejected");
  });
});
