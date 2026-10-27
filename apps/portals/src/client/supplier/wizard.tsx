// Supplier registration wizard: draft state (client-side), stepper, steps, review, success.

import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type FileMeta,
  type FormValues,
  initialValues,
  type RawValue,
  type SectionDef,
  visibleFields,
} from "../../shared/fields.ts";
import {
  type StepDef,
  SUPPLIER_ACTIONS,
  SUPPLIER_FILE_FIELDS,
  supplierSteps,
  type TenantInfo,
} from "../../shared/supplierSchema.ts";
import type { SupplierRecord } from "../../shared/types.ts";
import { validateSections } from "../../shared/validate.ts";
import {
  boot,
  bootData,
  cx,
  M,
  navigate,
  preventImplicitSubmit,
  tid,
  tidBase,
  useLocation,
  useTitle,
} from "../runtime.ts";
import {
  ActionButton,
  ErrorSummary,
  errorItems,
  FormSection,
  fillVars,
  payloadFor,
  type ReadbackItem,
  ReadbackList,
  Wrap,
} from "../ui/form.tsx";
import { IconCheck, IconInfo } from "../ui/icons.tsx";

export interface WizardApi {
  tenant: TenantInfo;
  steps: StepDef[];
  sections: SectionDef[];
  values: FormValues;
  files: Record<string, File | null>;
  fileMetas: Record<string, FileMeta>;
  inviteCode: string | null;
  /** Validation errors per step index (always computed; shown once a step was attempted). */
  stepErrors: Array<Record<string, string>>;
  vars: Record<string, string>;
  setValue(key: string, value: RawValue): void;
  setFile(key: string, file: File | null): void;
  setInviteCode(code: string): void;
  resetDraft(): void;
}

const WizardContext = createContext<WizardApi | null>(null);

export function useWizard(): WizardApi {
  const w = useContext(WizardContext);
  if (!w) throw new Error("useWizard outside WizardProvider");
  return w;
}

export const supplierCache = new Map<string, SupplierRecord>();

export function stepUrl(tenant: TenantInfo, key: string): string {
  return `/t/${tenant.slug}/register/${key}`;
}

export function WizardProvider({ tenant, children }: { tenant: TenantInfo; children: ReactNode }) {
  const steps = useMemo(() => supplierSteps(tenant.slug, M), [tenant.slug]);
  const sections = useMemo(() => steps.flatMap((s) => s.sections), [steps]);
  const [values, setValues] = useState<FormValues>(() => initialValues(sections));
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [inviteCode, setInviteCode] = useState<string | null>(() => {
    const code = boot.data?.inviteCode;
    return typeof code === "string" && boot.data?.inviteValid !== false ? code : null;
  });

  const fileMetas = useMemo(() => {
    const out: Record<string, FileMeta> = {};
    for (const [key, f] of Object.entries(files))
      if (f) out[key] = { name: f.name, size: f.size, type: f.type };
    return out;
  }, [files]);

  const stepErrors = useMemo(
    () =>
      steps.map(
        (s) => validateSections(s.sections, values, { today: boot.serverDate, files: fileMetas }).errors,
      ),
    [steps, values, fileMetas],
  );

  const api: WizardApi = {
    tenant,
    steps,
    sections,
    values,
    files,
    fileMetas,
    inviteCode,
    stepErrors,
    vars: { buyer: tenant.name },
    setValue: (key, value) => setValues((prev) => ({ ...prev, [key]: value })),
    setFile: (key, file) => setFiles((prev) => ({ ...prev, [key]: file })),
    setInviteCode,
    resetDraft: () => {
      setValues(initialValues(sections));
      setFiles({});
    },
  };
  return <WizardContext.Provider value={api}>{children}</WizardContext.Provider>;
}

function firstInvalidStep(w: WizardApi): number {
  return w.stepErrors.findIndex((e) => Object.keys(e).length > 0);
}

function Stepper({ current }: { current: number }) {
  const w = useWizard();
  const firstInvalid = firstInvalidStep(w);
  const reachableUpTo = firstInvalid === -1 ? w.steps.length : firstInvalid;
  const items = [
    ...w.steps.map((s) => ({ key: s.key as string, title: s.title })),
    { key: "review", title: "Review" },
  ];
  return (
    <nav aria-label="Registration progress" className={cx("card", "stepper-card")}>
      <ol className={cx("stepper")}>
        {items.map((s, i) => {
          const isCurrent = i === current;
          const done = !isCurrent && i < reachableUpTo;
          const reachable = !isCurrent && i <= reachableUpTo;
          return (
            <li
              key={s.key}
              className={cx("step", done && "is-done", isCurrent && "is-current")}
              aria-current={isCurrent ? "step" : undefined}
            >
              <button
                type="button"
                className={cx("step-btn")}
                disabled={!reachable}
                aria-label={`${s.title}${done ? " (completed)" : isCurrent ? " (current step)" : ""}`}
                data-testid={tid(`step-${s.key}`)}
                onClick={() => navigate(stepUrl(w.tenant, s.key))}
              >
                <span className={cx("step-dot")} aria-hidden="true">
                  {done ? <IconCheck size={14} /> : i + 1}
                </span>
                <span className={cx("step-label")}>{s.title}</span>
              </button>
              {i < items.length - 1 && <span className={cx("step-line")} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function fieldsTitle(n: number): string {
  return n === 1 ? "Fix 1 field to continue" : `Fix ${n} fields to continue`;
}

function StepForm({ index }: { index: number }) {
  const w = useWizard();
  const step = w.steps[index] as StepDef;
  useTitle(`${step.heading} · ${w.tenant.portalName}`);
  const [attempted, setAttempted] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const stepErrors = w.stepErrors[index] ?? {};
  const errors = attempted ? stepErrors : {};
  const items = errorItems(step.sections, w.values, errors);
  const titleId = M.id("step-title");

  useLayoutEffect(() => {
    if (focusTick === 0) return;
    window.scrollTo(0, 0);
    summaryRef.current?.focus({ preventScroll: true });
  }, [focusTick]);

  function next(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(stepErrors).length > 0) {
      setFocusTick((t) => t + 1);
      return;
    }
    navigate(stepUrl(w.tenant, w.steps[index + 1]?.key ?? "review"));
  }

  function back() {
    const prev = w.steps[index - 1];
    if (prev) navigate(stepUrl(w.tenant, prev.key));
    else if (w.inviteCode) navigate(`/t/${w.tenant.slug}/invite/${w.inviteCode}`);
  }

  return (
    <form
      className={cx("card", "wizard-card")}
      noValidate
      aria-labelledby={titleId}
      onSubmit={next}
      onKeyDown={preventImplicitSubmit}
    >
      <div className={cx("step-head")}>
        <p className={cx("eyebrow")}>
          Step {index + 1} of {w.steps.length}
        </p>
        <h1 className={cx("step-title")} id={titleId}>
          {step.heading}
        </h1>
        <p className={cx("step-desc")}>{fillVars(step.description, w.vars)}</p>
      </div>
      {items.length > 0 && (
        <ErrorSummary
          ref={summaryRef}
          title={fieldsTitle(items.length)}
          items={items}
          testid={tid("error-summary")}
        />
      )}
      {step.sections.map((s) => (
        <FormSection
          key={s.key}
          section={s}
          values={w.values}
          errors={errors}
          onChange={w.setValue}
          files={w.files}
          onFile={w.setFile}
          vars={w.vars}
        />
      ))}
      <Wrap k="actions">
        <div className={cx("wizard-actions")}>
          {index > 0 || w.inviteCode ? (
            <button
              type="button"
              className={cx("btn", "btn-secondary")}
              data-testid={tid("back")}
              onClick={back}
            >
              Back
            </button>
          ) : (
            <span />
          )}
          <div className={cx("actions-right")}>
            <span className={cx("save-note")}>Your answers are kept while this tab stays open.</span>
            <ActionButton
              type="submit"
              actionKey="next"
              text={SUPPLIER_ACTIONS.next.text}
              synonyms={SUPPLIER_ACTIONS.next.synonyms}
              testid={tidBase("next")}
            />
          </div>
        </div>
      </Wrap>
    </form>
  );
}

function ReviewStep() {
  const w = useWizard();
  useTitle(`Review and submit · ${w.tenant.portalName}`);
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const normalized = validateSections(w.sections, w.values, {
    today: boot.serverDate,
    files: w.fileMetas,
  }).fields;
  const serverItems = errorItems(w.sections, w.values, serverErrors);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setFailure(null);
    setServerErrors({});
    const form = new FormData();
    form.set("payload", JSON.stringify(payloadFor(w.sections, w.values)));
    for (const key of SUPPLIER_FILE_FIELDS) {
      const file = w.files[key];
      if (file) form.set(key, file, file.name);
    }
    try {
      const res = await fetch(`/api/t/${w.tenant.slug}/suppliers`, {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => null)) as
        | (SupplierRecord & { fieldErrors?: Record<string, string> })
        | null;
      if (res.status === 401) {
        navigate(`/t/${w.tenant.slug}/login?next=${encodeURIComponent(stepUrl(w.tenant, "review"))}`);
        return;
      }
      if (res.status === 400 && data?.fieldErrors) {
        setServerErrors(data.fieldErrors);
        setSubmitting(false);
        window.scrollTo(0, 0);
        return;
      }
      if (!res.ok || !data) throw new Error(`HTTP ${res.status}`);
      supplierCache.set(data.id, data);
      w.resetDraft();
      navigate(`/t/${w.tenant.slug}/register/complete/${data.id}`);
    } catch {
      setFailure("We couldn't submit your registration. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  const lastStep = w.steps[w.steps.length - 1];
  return (
    <div className={cx("card", "wizard-card")}>
      <div className={cx("step-head")}>
        <p className={cx("eyebrow")}>Final step</p>
        <h1 className={cx("step-title")}>Review and submit</h1>
        <p className={cx("step-desc")}>
          Check your details before sending them to {w.tenant.name} for approval.
        </p>
      </div>
      {serverItems.length > 0 && (
        <ErrorSummary title="Some details need attention" items={serverItems} testid={tid("error-summary")} />
      )}
      {failure && (
        <div className={cx("alert", "alert-error", "error-summary")} role="alert">
          {failure}
        </div>
      )}
      {w.steps.map((step) => {
        const titleId = M.id(`review-${step.key}-title`);
        const items: ReadbackItem[] = visibleFields(step.sections, w.values).map((f) => {
          if (f.kind === "file") {
            const file = w.files[f.key];
            return { key: f.key, label: f.label, def: f, value: file?.name, display: file?.name ?? "" };
          }
          return { key: f.key, label: f.label, def: f, value: normalized[f.key] };
        });
        return (
          <section key={step.key} className={cx("review-section")} aria-labelledby={titleId}>
            <div className={cx("review-head")}>
              <h2 className={cx("review-title")} id={titleId}>
                {step.heading}
              </h2>
              <button
                type="button"
                className={cx("btn", "btn-link")}
                aria-label={`Edit ${step.heading.toLowerCase()}`}
                data-testid={tid(`edit-${step.key}`)}
                onClick={() => navigate(stepUrl(w.tenant, step.key))}
              >
                Edit
              </button>
            </div>
            <ReadbackList items={items} testid={tid(`review-${step.key}`)} />
          </section>
        );
      })}
      <div className={cx("review-note")}>
        <IconInfo size={18} />
        <span>
          By submitting, you confirm the information is accurate and that you are authorized to register this
          company as a supplier to {w.tenant.name}.
        </span>
      </div>
      <Wrap k="actions">
        <div className={cx("wizard-actions")}>
          <button
            type="button"
            className={cx("btn", "btn-secondary")}
            data-testid={tid("back")}
            onClick={() => lastStep && navigate(stepUrl(w.tenant, lastStep.key))}
          >
            Back
          </button>
          <div className={cx("actions-right")}>
            <ActionButton
              actionKey="submit"
              text={SUPPLIER_ACTIONS.submit.text}
              synonyms={SUPPLIER_ACTIONS.submit.synonyms}
              testid={tidBase("submit")}
              busy={submitting}
              busyText="Submitting…"
              onClick={submit}
            />
          </div>
        </div>
      </Wrap>
    </div>
  );
}

/** Steps + review. Direct loads of later steps redirect to the first incomplete step. */
export function WizardPage({ stepKey }: { stepKey: string }) {
  const w = useWizard();
  const isReview = stepKey === "review";
  const index = isReview ? w.steps.length : w.steps.findIndex((s) => s.key === stepKey);
  const firstInvalid = firstInvalidStep(w);
  let redirectTo: string | null = null;
  if (index < 0) redirectTo = w.steps[0]?.key ?? "company";
  else if (firstInvalid !== -1 && index > firstInvalid) redirectTo = w.steps[firstInvalid]?.key ?? "company";

  useLayoutEffect(() => {
    if (redirectTo) navigate(stepUrl(w.tenant, redirectTo), { replace: true });
  }, [redirectTo, w.tenant]);

  if (redirectTo) return null;
  return (
    <>
      <Stepper current={index} />
      {isReview ? <ReviewStep /> : <StepForm key={stepKey} index={index} />}
    </>
  );
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

export function SuccessPage({ id }: { id: string }) {
  const w = useWizard();
  const { pathname } = useLocation();
  useTitle(`Registration submitted · ${w.tenant.portalName}`);
  const initial = bootData<SupplierRecord>("supplier", pathname) ?? supplierCache.get(id.toUpperCase());
  const [record, setRecord] = useState<SupplierRecord | null | undefined>(initial);

  useEffect(() => {
    if (initial) return;
    let alive = true;
    fetch(`/api/t/${w.tenant.slug}/suppliers/${encodeURIComponent(id)}`, { credentials: "same-origin" })
      .then(async (res) => (res.ok ? ((await res.json()) as SupplierRecord) : null))
      .then((r) => {
        if (alive) setRecord(r);
      })
      .catch(() => {
        if (alive) setRecord(null);
      });
    return () => {
      alive = false;
    };
  }, [id, initial, w.tenant.slug]);

  if (record === undefined) return <div className={cx("card", "success")}>Loading…</div>;
  if (record === null) {
    return (
      <div className={cx("card", "success")}>
        <h1 className={cx("success-title")}>Registration not found</h1>
      </div>
    );
  }
  return (
    <div className={cx("card", "success")}>
      <div className={cx("success-icon")}>
        <IconCheck size={26} />
      </div>
      <h1 className={cx("success-title")}>Registration submitted</h1>
      <p className={cx("success-text")}>
        Thank you. {w.tenant.name} will review your registration and contact {record.primaryContactEmail} if
        anything else is needed.
      </p>
      <div className={cx("success-ids")}>
        <div>
          <div className={cx("id-label")}>Supplier ID</div>
          <div className={cx("id-value")} data-testid={tid("supplier-id")}>
            {record.id}
          </div>
        </div>
        <div>
          <div className={cx("id-label")}>Status</div>
          <span className={cx("badge", "badge-pending")} data-testid={tid("supplier-status")}>
            {record.status}
          </span>
        </div>
        <div>
          <div className={cx("id-label")}>Company</div>
          <div>{record.legalName}</div>
        </div>
        <div>
          <div className={cx("id-label")}>Submitted</div>
          <div>{fmtDateTime(record.submittedAt)}</div>
        </div>
      </div>
      <h2 className={cx("next-title")}>What happens next</h2>
      <ol className={cx("next-list")}>
        <li>
          {w.tenant.name} procurement reviews your company and banking details, usually within 3 to 5 business
          days.
        </li>
        <li>You'll get an email when your supplier account is approved.</li>
        <li>Once approved, you can receive purchase orders and submit invoices.</li>
      </ol>
    </div>
  );
}
