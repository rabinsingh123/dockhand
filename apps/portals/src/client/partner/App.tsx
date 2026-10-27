// Caravela Partner Hub SPA: routes, v1/v2 shells, login, registrations list, confirmation page.

import { type FormEvent, type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { allFields } from "../../shared/fields.ts";
import {
  PARTNER_ACTIONS,
  PARTNER_FIELD_LABELS,
  PARTNER_ORG,
  PARTNER_PORTAL_NAME,
  partnerSections,
} from "../../shared/partnerSchema.ts";
import type { DealRecord, DealStatus } from "../../shared/types.ts";
import { isoToDmy } from "../../shared/validate.ts";
import {
  api,
  boot,
  bootData,
  cx,
  M,
  matchPath,
  navigate,
  safeNext,
  tid,
  tidBase,
  useLocation,
  useTitle,
} from "../runtime.ts";
import { ActionButton, Footer, type ReadbackItem, ReadbackList } from "../ui/form.tsx";
import {
  CaravelaMark,
  IconAlert,
  IconBook,
  IconBriefcase,
  IconChart,
  IconCheck,
  IconClock,
  IconGrid,
  IconPlus,
} from "../ui/icons.tsx";
import { Crumbs, linkHandler } from "./Crumbs.tsx";
import { DealFormPage, dealCache } from "./DealForm.tsx";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function fmtMoney(v: unknown): string {
  return typeof v === "number" ? money.format(v) : "—";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function initials(name: string): string {
  const parts = name.split(/[\s._@-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "P") + (parts[1]?.[0] ?? "")).toUpperCase();
}

const STATUS_CLASS: Record<DealStatus, string> = {
  "Pending review": "badge-pending",
  Approved: "badge-approved",
  Declined: "badge-declined",
  Expired: "badge-expired",
};

function StatusBadge({ status, testid }: { status: DealStatus; testid?: string }) {
  return (
    <span className={cx("badge", STATUS_CLASS[status])} data-testid={testid}>
      {status}
    </span>
  );
}

async function signOut() {
  await api("/api/logout", { method: "POST" });
  boot.user = null;
  navigate("/login");
}

function ShellV1({ children }: { children: ReactNode }) {
  const user = boot.user?.username ?? "partner";
  return (
    <div className={cx("app", "v1")}>
      <header className={cx("topbar")}>
        <div className={cx("topbar-inner")}>
          <a href="/deals" className={cx("brand")} data-testid={tid("home")} onClick={linkHandler("/deals")}>
            <CaravelaMark />
            <span className={cx("brand-name")}>Caravela</span>
            <span className={cx("brand-sub")}>Partner Hub</span>
          </a>
          <nav aria-label="Main" className={cx("topnav")}>
            <a
              href="/deals"
              className={cx("topnav-link", "is-active")}
              aria-current="page"
              data-testid={tid("nav-deals")}
              onClick={linkHandler("/deals")}
            >
              Deal registrations
            </a>
          </nav>
          <div className={cx("topbar-user")}>
            <div className={cx("org")}>
              <span className={cx("org-name")}>{PARTNER_ORG}</span>
              <span>{user}</span>
            </div>
            <span className={cx("avatar")} aria-hidden="true">
              {initials(user)}
            </span>
            <button type="button" className={cx("signout")} data-testid={tid("sign-out")} onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className={cx("app-main")}>
        <div className={cx("page")}>{children}</div>
      </main>
      <Footer />
    </div>
  );
}

function ShellV2({ children }: { children: ReactNode }) {
  const user = boot.user?.username ?? "partner";
  return (
    <div className={cx("app", "v2", "shell2")}>
      <aside className={cx("sidebar")}>
        <a
          href="/deals"
          className={cx("side-brand")}
          data-testid={tid("home")}
          onClick={linkHandler("/deals")}
        >
          <CaravelaMark size={32} />
          <span>
            <span className={cx("side-brand-name")}>Caravela</span>
            <br />
            <span className={cx("side-brand-sub")}>Partner Hub</span>
          </span>
        </a>
        <nav aria-label="Main" className={cx("side-nav")}>
          <p className={cx("side-label")}>Sell</p>
          <span className={cx("side-link", "is-disabled")} aria-disabled="true">
            <IconGrid size={18} />
            Overview
          </span>
          <a
            href="/deals"
            className={cx("side-link", "is-active")}
            aria-current="page"
            data-testid={tid("nav-opportunities")}
            onClick={linkHandler("/deals")}
          >
            <IconBriefcase size={18} />
            Opportunities
          </a>
          <span className={cx("side-link", "is-disabled")} aria-disabled="true">
            <IconChart size={18} />
            Pipeline
          </span>
          <p className={cx("side-label")}>Enable</p>
          <span className={cx("side-link", "is-disabled")} aria-disabled="true">
            <IconBook size={18} />
            Resources
          </span>
        </nav>
        <div className={cx("side-foot")}>
          <strong>{PARTNER_ORG}</strong>
          Partner account
        </div>
      </aside>
      <div className={cx("main2")}>
        <header className={cx("header2")}>
          <span className={cx("muted")}>{PARTNER_ORG} workspace</span>
          <div className={cx("user2")}>
            <span>{user}</span>
            <span className={cx("avatar")} aria-hidden="true">
              {initials(user)}
            </span>
            <button type="button" className={cx("signout2")} data-testid={tid("sign-out")} onClick={signOut}>
              Sign out
            </button>
          </div>
        </header>
        <main className={cx("content2")}>{children}</main>
        <Footer />
      </div>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return boot.version === "v2" ? <ShellV2>{children}</ShellV2> : <ShellV1>{children}</ShellV1>;
}

function LoginPage({ next }: { next: string | null }) {
  useTitle(`Sign in · ${PARTNER_PORTAL_NAME}`);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const uId = M.id("login-username");
  const pId = M.id("login-password");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const errs: Record<string, string> = {};
    if (!username.trim()) errs.username = "Enter your username.";
    if (!password) errs.password = "Enter your password.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    const res = await api<{ fieldErrors?: Record<string, string> }>("/api/login", {
      method: "POST",
      json: { username, password },
    });
    if (!res.ok) {
      setErrors(res.data?.fieldErrors ?? { username: "Sign-in failed. Try again." });
      setBusy(false);
      return;
    }
    boot.user = { username: username.trim() };
    navigate(safeNext(next, "/deals"), { replace: true });
  }

  const input = (
    id: string,
    key: "username" | "password",
    label: string,
    value: string,
    set: (v: string) => void,
  ) => (
    <div className={cx("field", errors[key] && "has-error")}>
      <div className={cx("label-row")}>
        <label htmlFor={id} className={cx("field-label")}>
          {label}
        </label>
        <span className={cx("req")} aria-hidden="true">
          *
        </span>
      </div>
      <input
        id={id}
        type={key === "password" ? "password" : "text"}
        className={cx("input")}
        autoComplete={key === "password" ? "current-password" : "username"}
        aria-required="true"
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `${id}-error` : undefined}
        data-testid={tid(`login-${key}`)}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
      {errors[key] && (
        <p id={`${id}-error`} className={cx("field-error")} role="alert">
          <IconAlert size={14} />
          <span>{errors[key]}</span>
        </p>
      )}
    </div>
  );

  return (
    <div className={cx("app", boot.version)}>
      <main className={cx("login")}>
        <div className={cx("card", "login-card")}>
          <div className={cx("login-brand")}>
            <CaravelaMark size={38} />
            <div>
              <div className={cx("login-brand-name")}>Caravela</div>
              <div className={cx("login-brand-sub")}>Partner Hub</div>
            </div>
          </div>
          <h1 className={cx("login-title")}>Sign in</h1>
          <p className={cx("login-sub")}>Use your Caravela partner account.</p>
          <form className={cx("login-form")} noValidate onSubmit={submit}>
            {input(uId, "username", "Username", username, setUsername)}
            {input(pId, "password", "Password", password, setPassword)}
            <button
              type="submit"
              className={cx("btn", "btn-primary")}
              data-testid={tid("login-submit")}
              disabled={busy}
            >
              {busy ? (
                <>
                  <span className={cx("spinner")} aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
          <p className={cx("login-foot")}>Trouble signing in? Contact your Caravela channel manager.</p>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function DealsPage() {
  const { pathname } = useLocation();
  const v2 = boot.version === "v2";
  useTitle(`${v2 ? "Opportunities" : "Deal registrations"} · ${PARTNER_PORTAL_NAME}`);
  const initial = bootData<DealRecord[]>("deals", pathname);
  const [deals, setDeals] = useState<DealRecord[] | null>(initial ?? null);

  useEffect(() => {
    if (initial) return;
    let alive = true;
    api<{ deals: DealRecord[] }>("/api/deals").then((res) => {
      if (res.status === 401) navigate(`/login?next=${encodeURIComponent("/deals")}`);
      else if (alive && res.data) setDeals(res.data.deals);
    });
    return () => {
      alive = false;
    };
  }, [initial]);

  const list = deals ?? [];
  const pending = list.filter((d) => d.status === "Pending review").length;
  const approved = list.filter((d) => d.status === "Approved").length;
  const protectedValue = list
    .filter((d) => d.status === "Approved" || d.status === "Pending review")
    .reduce((sum, d) => sum + (typeof d.fields.estimatedValue === "number" ? d.fields.estimatedValue : 0), 0);

  return (
    <>
      <div className={cx("page-head")}>
        <div>
          <h1 className={cx("page-title")}>{v2 ? "Opportunity registrations" : "Deal registrations"}</h1>
          <p className={cx("page-sub")}>
            Register opportunities with Caravela to secure protected partner pricing.
          </p>
        </div>
        <ActionButton
          actionKey="newDeal"
          text={PARTNER_ACTIONS.newDeal.text}
          synonyms={PARTNER_ACTIONS.newDeal.synonyms}
          testid={tidBase(v2 ? "new-registration" : "register-deal")}
          onClick={() => navigate("/deals/new")}
          icon={<IconPlus />}
        />
      </div>
      <div className={cx("stats")}>
        <div className={cx("card", "stat")}>
          <div className={cx("stat-label")}>Pending review</div>
          <div className={cx("stat-value")}>{pending}</div>
          <div className={cx("stat-note")}>Reviewed within 2 business days</div>
        </div>
        <div className={cx("card", "stat")}>
          <div className={cx("stat-label")}>Approved</div>
          <div className={cx("stat-value")}>{approved}</div>
          <div className={cx("stat-note")}>Protected pricing active</div>
        </div>
        <div className={cx("card", "stat")}>
          <div className={cx("stat-label")}>Protected pipeline</div>
          <div className={cx("stat-value")}>{fmtMoney(protectedValue)}</div>
          <div className={cx("stat-note")}>Approved and pending, USD</div>
        </div>
      </div>
      <section className={cx("card", "table-card")} aria-labelledby={M.id("deals-table-title")}>
        <div className={cx("table-head")}>
          <h2 className={cx("table-title")} id={M.id("deals-table-title")}>
            Recent registrations
          </h2>
          <span className={cx("muted")}>{deals ? `${list.length} total` : "Loading…"}</span>
        </div>
        <table className={cx("table")}>
          <thead>
            <tr>
              <th scope="col">Registration</th>
              <th scope="col">End customer</th>
              <th scope="col">Product</th>
              <th scope="col" className={cx("num")}>
                Seats
              </th>
              <th scope="col" className={cx("num")}>
                Est. value
              </th>
              <th scope="col">Expected close</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.id}>
                <td>
                  <a
                    href={`/deals/${d.id}`}
                    className={cx("table-link")}
                    data-testid={tid(`deal-link-${d.id.toLowerCase()}`)}
                    onClick={linkHandler(`/deals/${d.id}`)}
                  >
                    {d.id}
                  </a>
                  <span className={cx("cell-sub")}>{fmtDate(d.submittedAt)}</span>
                </td>
                <td>
                  <span className={cx("cell-main")}>{String(d.fields.companyName ?? "")}</span>
                  <span className={cx("cell-sub")}>
                    {[d.fields.city, d.fields.country].filter(Boolean).join(", ")}
                  </span>
                </td>
                <td>{String(d.fields.product ?? "")}</td>
                <td className={cx("num")}>{String(d.fields.seats ?? "")}</td>
                <td className={cx("num")}>{fmtMoney(d.fields.estimatedValue)}</td>
                <td>
                  {typeof d.fields.expectedCloseDate === "string" ? isoToDmy(d.fields.expectedCloseDate) : ""}
                </td>
                <td>
                  <StatusBadge status={d.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {deals && list.length === 0 && <p className={cx("empty")}>No registrations yet.</p>}
      </section>
    </>
  );
}

function readbackItems(deal: DealRecord): ReadbackItem[] {
  const defs = allFields(partnerSections(boot.version, M));
  const items: ReadbackItem[] = defs.map((f) => ({
    key: f.key,
    label: f.label,
    def: f,
    value: deal.fields[f.key],
  }));
  for (const [key, value] of Object.entries(deal.fields)) {
    if (!defs.some((f) => f.key === key)) {
      items.push({
        key,
        label: PARTNER_FIELD_LABELS[key] ?? key,
        value,
        ...(key === "expectedCloseDate" ? { def: { kind: "date" as const } } : {}),
      });
    }
  }
  return items;
}

function DealDetailPage({ id }: { id: string }) {
  const { pathname } = useLocation();
  const v2 = boot.version === "v2";
  const initial = bootData<DealRecord>("deal", pathname) ?? dealCache.get(id.toUpperCase());
  const [deal, setDeal] = useState<DealRecord | null | undefined>(initial);
  useTitle(
    `${deal?.seeded === false ? "Registration received" : `Registration ${id}`} · ${PARTNER_PORTAL_NAME}`,
  );

  useEffect(() => {
    if (initial) return;
    let alive = true;
    api<DealRecord>(`/api/deals/${encodeURIComponent(id)}`).then((res) => {
      if (res.status === 401) navigate(`/login?next=${encodeURIComponent(`/deals/${id}`)}`);
      else if (alive) setDeal(res.ok ? res.data : null);
    });
    return () => {
      alive = false;
    };
  }, [id, initial]);

  if (deal === undefined) return <div className={cx("card", "empty")}>Loading registration…</div>;
  if (deal === null) return <NotFound />;

  const isNew = !deal.seeded;
  const listLabel = v2 ? "Opportunities" : "Deal registrations";
  return (
    <>
      <Crumbs items={[{ label: listLabel, href: "/deals" }, { label: deal.id }]} />
      <div className={cx("card", "confirm")}>
        <span className={cx("confirm-icon")}>
          {isNew ? <IconCheck size={22} /> : <IconClock size={22} />}
        </span>
        <div>
          <h1 className={cx("confirm-title")}>
            {isNew ? "Registration received" : `Registration ${deal.id}`}
          </h1>
          <p className={cx("confirm-text")}>
            {isNew
              ? "Caravela's partner team reviews new registrations within 2 business days. Protected pricing applies once the registration is approved."
              : `Submitted ${fmtDate(deal.submittedAt)}.`}
          </p>
          <div className={cx("id-row")}>
            <div>
              <div className={cx("id-label")}>Registration ID</div>
              <div className={cx("id-value")} data-testid={tid("registration-id")}>
                {deal.id}
              </div>
            </div>
            <div>
              <div className={cx("id-label")}>Status</div>
              <StatusBadge status={deal.status} testid={tid("registration-status")} />
            </div>
            <div>
              <div className={cx("id-label")}>Submitted</div>
              <div>{fmtDateTime(deal.submittedAt)}</div>
            </div>
          </div>
        </div>
      </div>
      <section className={cx("card", "detail-card")} aria-labelledby={M.id("details-title")}>
        <div className={cx("detail-head")}>
          <h2 className={cx("detail-title")} id={M.id("details-title")}>
            Registration details
          </h2>
        </div>
        <ReadbackList items={readbackItems(deal)} testid={tid("registration-fields")} />
      </section>
      <div className={cx("detail-actions")}>
        <button
          type="button"
          className={cx("btn", "btn-secondary")}
          data-testid={tid("back-to-deals")}
          onClick={() => navigate("/deals")}
        >
          Back to {v2 ? "opportunities" : "deals"}
        </button>
        <button
          type="button"
          className={cx("btn", "btn-primary")}
          data-testid={tid("register-another")}
          onClick={() => navigate("/deals/new")}
        >
          Register another deal
        </button>
      </div>
    </>
  );
}

function NotFound() {
  useTitle(`Page not found · ${PARTNER_PORTAL_NAME}`);
  return (
    <div className={cx("card", "notfound")}>
      <h1>Page not found</h1>
      <p className={cx("muted")}>
        The page you're looking for doesn't exist.{" "}
        <a href="/deals" data-testid={tid("notfound-home")} onClick={linkHandler("/deals")}>
          Go to deal registrations
        </a>
      </p>
    </div>
  );
}

function Redirect({ to }: { to: string }) {
  useLayoutEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

export function App() {
  const { pathname, query } = useLocation();
  if (pathname === "/login") return <LoginPage next={query.get("next")} />;
  if (pathname === "/") return <Redirect to="/deals" />;
  if (bootData<boolean>("notFound", pathname)) {
    return (
      <Shell>
        <NotFound />
      </Shell>
    );
  }
  if (pathname === "/deals") {
    return (
      <Shell>
        <DealsPage />
      </Shell>
    );
  }
  if (pathname === "/deals/new") {
    return (
      <Shell>
        <DealFormPage />
      </Shell>
    );
  }
  const m = matchPath("/deals/:id", pathname);
  if (m?.id) {
    return (
      <Shell>
        <DealDetailPage key={m.id} id={m.id} />
      </Shell>
    );
  }
  return (
    <Shell>
      <NotFound />
    </Shell>
  );
}
