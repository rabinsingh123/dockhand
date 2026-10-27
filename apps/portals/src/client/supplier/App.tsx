// Supplier Portal SPA: tenant shell (buyer brand only), invite landing, login, wizard routes.

import { type CSSProperties, type FormEvent, type ReactNode, useLayoutEffect, useState } from "react";
import {
  getTenant,
  isValidInviteCode,
  SUPPLIER_ACTIONS,
  type TenantInfo,
} from "../../shared/supplierSchema.ts";
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
import { ActionButton, Footer } from "../ui/form.tsx";
import { AcmeMark, GlobexMark, IconAlert, IconCheck } from "../ui/icons.tsx";
import { SuccessPage, stepUrl, useWizard, WizardPage, WizardProvider } from "./wizard.tsx";

function TenantMark({ tenant, size }: { tenant: TenantInfo; size?: number }) {
  return tenant.slug === "globex" ? <GlobexMark size={size} /> : <AcmeMark size={size} />;
}

function brandVars(t: TenantInfo): CSSProperties {
  return {
    "--primary": t.brand.primary,
    "--primary-hover": t.brand.hover,
    "--primary-tint": t.brand.tint,
    "--primary-ink": t.brand.ink,
    "--focus-ring": t.brand.ring,
    "--link": t.brand.primary,
  } as CSSProperties;
}

function TenantShell({ tenant, children }: { tenant: TenantInfo; children: ReactNode }) {
  return (
    <div className={cx("sg")} style={brandVars(tenant)}>
      <header className={cx("sg-top")}>
        <div className={cx("sg-top-inner")}>
          <div className={cx("tenant")}>
            <TenantMark tenant={tenant} />
            <div className={cx("tenant-line")}>
              <span className={cx("tenant-name")}>{tenant.name}</span>{" "}
              <span className={cx("tenant-dot")}>·</span>{" "}
              <span className={cx("tenant-sub")}>Supplier Portal</span>
            </div>
          </div>
          <div className={cx("top-help")}>
            Questions? <strong>{tenant.contactEmail}</strong>
          </div>
        </div>
      </header>
      <main className={cx("sg-main")}>{children}</main>
      <Footer />
    </div>
  );
}

function InvitePage({ code }: { code: string }) {
  const w = useWizard();
  const { pathname } = useLocation();
  useTitle(`Supplier invitation · ${w.tenant.portalName}`);
  const valid = bootData<boolean>("inviteValid", pathname) ?? isValidInviteCode(w.tenant, code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalized = code.toUpperCase();

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await api<{ next: string }>(
      `/api/t/${w.tenant.slug}/invite/${encodeURIComponent(normalized)}/start`,
      { method: "POST" },
    );
    if (!res.ok || !res.data) {
      setError("We couldn't start your registration. Check the invitation link and try again.");
      setBusy(false);
      return;
    }
    w.setInviteCode(normalized);
    navigate(res.data.next);
  }

  if (!valid) {
    return (
      <div className={cx("card", "invite")}>
        <TenantMark tenant={w.tenant} size={44} />
        <h1 className={cx("invite-title")}>This invitation link isn't valid</h1>
        <p className={cx("invite-text")}>
          The code <strong>{normalized}</strong> doesn't match an open supplier invitation from{" "}
          {w.tenant.name}. Check the link in your invitation email, or contact {w.tenant.contactEmail}.
        </p>
      </div>
    );
  }

  return (
    <div className={cx("card", "invite")}>
      <TenantMark tenant={w.tenant} size={44} />
      <h1 className={cx("invite-title")}>
        You've been invited to register as a supplier for {w.tenant.name}
      </h1>
      <p className={cx("invite-text")}>
        {w.tenant.requester} uses this portal to onboard new suppliers. You can review everything before you
        submit, and nothing is sent until you choose Submit for approval.
      </p>
      <div className={cx("invite-meta")}>
        <div>
          <div className={cx("meta-label")}>Invitation code</div>
          <div className={cx("meta-value")} data-testid={tid("invite-code")}>
            {normalized}
          </div>
        </div>
        <div>
          <div className={cx("meta-label")}>Requested by</div>
          <div className={cx("meta-value")}>{w.tenant.requester}</div>
        </div>
        <div>
          <div className={cx("meta-label")}>Time needed</div>
          <div className={cx("meta-value")}>About 10 minutes</div>
        </div>
      </div>
      <p className={cx("check-title")}>Have these ready</p>
      <ul className={cx("checklist")}>
        <li>
          <IconCheck size={16} />
          Legal name and tax ID (EIN)
        </li>
        <li>
          <IconCheck size={16} />
          Business and remit-to address
        </li>
        <li>
          <IconCheck size={16} />
          Bank account and routing number
        </li>
        <li>
          <IconCheck size={16} />
          W-9 and certificate of insurance (PDF)
        </li>
      </ul>
      {error && (
        <div className={cx("alert", "alert-error", "invite-alert")} role="alert">
          {error}
        </div>
      )}
      <div className={cx("invite-actions")}>
        <ActionButton
          actionKey="start"
          text={SUPPLIER_ACTIONS.start.text}
          synonyms={SUPPLIER_ACTIONS.start.synonyms}
          testid={tidBase("start")}
          busy={busy}
          busyText="Starting…"
          onClick={start}
        />
        <span className={cx("muted")}>Five steps, then a review before you submit.</span>
      </div>
    </div>
  );
}

function LoginPage({ next }: { next: string | null }) {
  const w = useWizard();
  useTitle(`Sign in · ${w.tenant.portalName}`);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

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
    navigate(safeNext(next, stepUrl(w.tenant, "company")), { replace: true });
  }

  const field = (key: "username" | "password", label: string, value: string, set: (v: string) => void) => {
    const id = M.id(`login-${key}`);
    return (
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
  };

  return (
    <div className={cx("login-wrap")}>
      <div className={cx("card", "login-card")}>
        <TenantMark tenant={w.tenant} size={40} />
        <h1 className={cx("login-title")}>Sign in to continue your registration</h1>
        <p className={cx("login-sub")}>
          New supplier? Open the invitation link from {w.tenant.name} instead.
        </p>
        <form className={cx("login-form")} noValidate onSubmit={submit}>
          {field("username", "Username", username, setUsername)}
          {field("password", "Password", password, setPassword)}
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
      </div>
    </div>
  );
}

function NotFound() {
  useTitle("Page not found · Supplier Portal");
  return (
    <div className={cx("card", "notfound")}>
      <h1>Page not found</h1>
      <p className={cx("muted")}>Check the link in your invitation email.</p>
    </div>
  );
}

function HomePage() {
  useTitle("Supplier Portal");
  return (
    <div className={cx("sg")}>
      <header className={cx("home-top")}>
        <div className={cx("home-top-inner")}>Supplier Portal</div>
      </header>
      <main className={cx("sg-main")}>
        <div className={cx("card", "home")}>
          <h1 className={cx("home-title")}>Supplier registration</h1>
          <p className={cx("home-text")}>
            Buyers use this portal to onboard their suppliers. To get started, open the invitation link you
            received from your customer.
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function Redirect({ to }: { to: string }) {
  useLayoutEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

function TenantRoutes({
  tenant,
  pathname,
  query,
}: {
  tenant: TenantInfo;
  pathname: string;
  query: URLSearchParams;
}) {
  if (bootData<boolean>("notFound", pathname)) return <NotFound />;
  const base = `/t/${tenant.slug}`;
  let m = matchPath("/t/:tenant/invite/:code", pathname);
  if (m?.code) return <InvitePage key={m.code} code={m.code} />;
  if (pathname === `${base}/login`) return <LoginPage next={query.get("next")} />;
  if (pathname === `${base}/register` || pathname === base)
    return <Redirect to={stepUrl(tenant, "company")} />;
  m = matchPath("/t/:tenant/register/complete/:id", pathname);
  if (m?.id) return <SuccessPage key={m.id} id={m.id} />;
  m = matchPath("/t/:tenant/register/:step", pathname);
  if (m?.step) return <WizardPage stepKey={m.step} />;
  return <NotFound />;
}

export function App() {
  const { pathname, query } = useLocation();
  if (pathname === "/") return <HomePage />;
  const segments = pathname.split("/").filter(Boolean);
  const tenant = segments[0] === "t" ? getTenant(segments[1]) : undefined;
  if (!tenant) {
    return (
      <div className={cx("sg")}>
        <header className={cx("home-top")}>
          <div className={cx("home-top-inner")}>Supplier Portal</div>
        </header>
        <main className={cx("sg-main")}>
          <NotFound />
        </main>
        <Footer />
      </div>
    );
  }
  return (
    <TenantShell tenant={tenant}>
      <WizardProvider key={tenant.slug} tenant={tenant}>
        <TenantRoutes tenant={tenant} pathname={pathname} query={query} />
      </WizardProvider>
    </TenantShell>
  );
}
