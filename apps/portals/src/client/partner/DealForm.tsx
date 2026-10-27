// Deal registration form (/deals/new). Layout, labels and testids come from the version + mutation.

import { type FormEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type FormValues, initialValues, type RawValue } from "../../shared/fields.ts";
import { PARTNER_ACTIONS, PARTNER_PORTAL_NAME, partnerSections } from "../../shared/partnerSchema.ts";
import type { DealRecord } from "../../shared/types.ts";
import { validateSections } from "../../shared/validate.ts";
import { api, boot, cx, M, navigate, preventImplicitSubmit, tid, tidBase, useTitle } from "../runtime.ts";
import { ActionButton, ErrorSummary, errorItems, FormSection, payloadFor, Wrap } from "../ui/form.tsx";
import { IconCheck, IconInfo, IconShield } from "../ui/icons.tsx";
import { Crumbs } from "./Crumbs.tsx";

/** Registrations returned by the submit call, so the confirmation page renders without a fetch. */
export const dealCache = new Map<string, DealRecord>();

type SubmitResponse = DealRecord & { duplicate?: boolean; fieldErrors?: Record<string, string> };

function problemsTitle(n: number): string {
  return n === 1
    ? "There is 1 problem with this registration"
    : `There are ${n} problems with this registration`;
}

export function DealFormPage() {
  const v2 = boot.version === "v2";
  useTitle(`${v2 ? "New registration" : "Register a deal"} · ${PARTNER_PORTAL_NAME}`);
  const sections = useMemo(() => partnerSections(boot.version, M), []);
  const [values, setValues] = useState<FormValues>(() => initialValues(sections));
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  const validation = useMemo(
    () => validateSections(sections, values, { today: boot.serverDate }),
    [sections, values],
  );
  const errors = attempted ? { ...serverErrors, ...validation.errors } : serverErrors;
  const items = errorItems(sections, values, errors);

  useLayoutEffect(() => {
    if (focusTick === 0) return;
    window.scrollTo(0, 0);
    summaryRef.current?.focus({ preventScroll: true });
  }, [focusTick]);

  function setValue(key: string, value: RawValue) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setAttempted(true);
    setFailure(null);
    if (Object.keys(validation.errors).length > 0) {
      setFocusTick((t) => t + 1);
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<SubmitResponse>("/api/deals", {
        method: "POST",
        json: payloadFor(sections, values),
      });
      if (res.status === 401) {
        navigate(`/login?next=${encodeURIComponent("/deals/new")}`);
        return;
      }
      if (res.status === 400 && res.data?.fieldErrors) {
        setServerErrors(res.data.fieldErrors);
        setSubmitting(false);
        setFocusTick((t) => t + 1);
        return;
      }
      if (!res.ok || !res.data) throw new Error(`HTTP ${res.status}`);
      dealCache.set(res.data.id, res.data);
      navigate(`/deals/${res.data.id}`);
    } catch {
      setFailure("We couldn't submit your registration. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  const titleId = M.id("page-title");
  return (
    <>
      <Crumbs
        items={[
          { label: v2 ? "Opportunities" : "Deal registrations", href: "/deals" },
          { label: v2 ? "New registration" : "Register a deal" },
        ]}
      />
      <div className={cx("page-head")}>
        <div>
          <h1 className={cx("page-title")} id={titleId}>
            {v2 ? "Register an opportunity" : "Register a deal"}
          </h1>
          <p className={cx("page-sub")}>
            {v2
              ? "Share the opportunity details. Approved registrations get protected partner pricing."
              : "Register your opportunity with Caravela to receive protected partner pricing."}
          </p>
        </div>
      </div>
      <div className={cx(v2 ? "form-layout-2" : "form-layout")}>
        <form
          className={cx("card", "form-card")}
          noValidate
          aria-labelledby={titleId}
          onSubmit={onSubmit}
          onKeyDown={preventImplicitSubmit}
        >
          {items.length > 0 && (
            <ErrorSummary
              ref={summaryRef}
              title={problemsTitle(items.length)}
              items={items}
              testid={tid("error-summary")}
            />
          )}
          {failure && (
            <div className={cx("alert", "alert-error", "error-summary")} role="alert">
              {failure}
            </div>
          )}
          {sections.map((s) => (
            <FormSection key={s.key} section={s} values={values} errors={errors} onChange={setValue} />
          ))}
          <Wrap k="actions">
            <div className={cx("form-actions")}>
              <span className={cx("form-note")}>
                <span className={cx("req")} aria-hidden="true">
                  *
                </span>{" "}
                Required field
              </span>
              <button
                type="button"
                className={cx("btn", "btn-secondary")}
                data-testid={tid("cancel")}
                onClick={() => navigate("/deals")}
              >
                Cancel
              </button>
              <ActionButton
                type="submit"
                actionKey="submit"
                text={v2 ? PARTNER_ACTIONS.submit.v2 : PARTNER_ACTIONS.submit.v1}
                synonyms={PARTNER_ACTIONS.submit.synonyms}
                testid={v2 ? undefined : tidBase("submit")}
                busy={submitting}
                busyText="Submitting…"
              />
            </div>
          </Wrap>
        </form>
        {!v2 && (
          <aside className={cx("aside")} aria-label="About deal registration">
            <div className={cx("card", "aside-card")}>
              <h2 className={cx("aside-title")}>
                <IconShield size={18} />
                Why register?
              </h2>
              <ul className={cx("aside-list")}>
                <li>
                  <IconCheck size={14} />
                  Protected partner pricing for 90 days
                </li>
                <li>
                  <IconCheck size={14} />
                  Priority pre-sales support from Caravela
                </li>
                <li>
                  <IconCheck size={14} />
                  First registration wins channel conflicts
                </li>
              </ul>
            </div>
            <div className={cx("card", "aside-card")}>
              <h2 className={cx("aside-title")}>
                <IconInfo size={18} />
                Before you submit
              </h2>
              <p className={cx("aside-text")}>
                Registrations are reviewed within 2 business days. Use the end customer's legal company name
                and a close date in the future.
              </p>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
