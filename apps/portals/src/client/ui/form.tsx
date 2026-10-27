// Schema-driven form rendering shared by both portals. All ids, classes and testids go through the
// mutator, so DOM-level mutation operators apply uniformly.

import { type ReactNode, type Ref, useRef } from "react";
import {
  conditionHolds,
  emptyValueFor,
  type FieldDef,
  type FormValues,
  type RawValue,
  type SectionDef,
  slug,
  visibleFields,
} from "../../shared/fields.ts";
import type { FieldValue } from "../../shared/types.ts";
import { canonicalString, displayValue, formatBytes } from "../../shared/validate.ts";
import { cx, M } from "../runtime.ts";
import { Combobox } from "./Combobox.tsx";
import { IconAlert, IconFile } from "./icons.tsx";

export function fillVars(template: string, vars: Record<string, string> | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** wrapper_divs: extra layout-neutral wrappers (display: contents) that break structural CSS paths. */
export function Wrap({ k, children }: { k: string; children: ReactNode }) {
  const depth = M.wrapDepth(k);
  let node: ReactNode = children;
  for (let i = 0; i < depth; i++) {
    node = (
      <div className={cx(`wrap-${i}`)} style={{ display: "contents" }}>
        {node}
      </div>
    );
  }
  return <>{node}</>;
}

function Req() {
  return (
    <span className={cx("req")} aria-hidden="true">
      *
    </span>
  );
}

function inputType(kind: FieldDef["kind"]): string {
  if (kind === "email") return "email";
  if (kind === "tel") return "tel";
  return "text";
}

function toggleOption(def: FieldDef, list: string[], option: string, checked: boolean): string[] {
  if (!checked) return list.filter((x) => x !== option);
  if (def.exclusiveOption && option === def.exclusiveOption) return [option];
  return [...list.filter((x) => x !== def.exclusiveOption && x !== option), option];
}

export interface FieldViewProps {
  def: FieldDef;
  value: RawValue | undefined;
  error?: string;
  onChange(value: RawValue): void;
  file?: File | null;
  onFile?(file: File | null): void;
  vars?: Record<string, string>;
}

export function FieldView({ def, value, error, onChange, file, onFile, vars }: FieldViewProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const id = M.id(def.domId);
  const labelId = M.id(`${def.domId}-label`);
  const hintId = M.id(`${def.domId}-hint`);
  const errorId = M.id(`${def.domId}-error`);
  const hint = def.hint ? fillVars(def.hint, vars) : undefined;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const invalid = Boolean(error);
  const testid = M.testid(def.testid);
  const str = typeof value === "string" ? value : "";
  const fieldClass = cx("field", def.span === 2 && "span-2", invalid && "has-error");

  const hintEl = hint ? (
    <p id={hintId} className={cx("field-hint")}>
      {hint}
    </p>
  ) : null;
  const errorEl = error ? (
    <p id={errorId} className={cx("field-error")} role="alert">
      <IconAlert size={14} />
      <span>{error}</span>
    </p>
  ) : null;
  const labelRow = (
    <div className={cx("label-row")}>
      <label id={labelId} htmlFor={id} className={cx("field-label")}>
        {def.label}
      </label>
      {def.required && <Req />}
    </div>
  );
  const common = {
    id,
    "aria-required": def.required ? true : undefined,
    "aria-invalid": invalid ? true : undefined,
    "aria-describedby": describedBy,
    required: def.required,
    "data-testid": testid,
  };

  switch (def.kind) {
    case "checkbox":
      return (
        <div className={fieldClass}>
          <div className={cx("check-row")}>
            <label id={labelId} htmlFor={id} className={cx("check")}>
              <input
                {...common}
                type="checkbox"
                className={cx("check-input")}
                checked={value === true}
                onChange={(e) => onChange(e.target.checked)}
              />
              <span className={cx("check-text")}>{def.label}</span>
            </label>
            {def.required && <Req />}
          </div>
          {hintEl}
          {errorEl}
        </div>
      );

    case "radio":
    case "checkboxGroup": {
      const isRadio = def.kind === "radio";
      const list = Array.isArray(value) ? value : [];
      const legend = (
        <legend className={cx("group-legend")}>
          <span id={labelId} className={cx("field-label")}>
            {def.label}
          </span>
          {def.required && <Req />}
        </legend>
      );
      const choices = (
        <div className={cx("choice-row")}>
          {(def.options ?? []).map((opt) => {
            const optionId = M.id(`${def.domId}-${slug(opt)}`);
            const checked = isRadio ? str === opt : list.includes(opt);
            return (
              <label key={opt} htmlFor={optionId} className={cx("choice", checked && "is-checked")}>
                <input
                  id={optionId}
                  type={isRadio ? "radio" : "checkbox"}
                  name={isRadio ? id : undefined}
                  value={opt}
                  checked={checked}
                  required={isRadio ? def.required : undefined}
                  className={cx("choice-input")}
                  data-testid={M.testid(`${def.testid}-${slug(opt)}`)}
                  onChange={(e) => onChange(isRadio ? opt : toggleOption(def, list, opt, e.target.checked))}
                />
                <span>{opt}</span>
              </label>
            );
          })}
        </div>
      );
      if (isRadio) {
        // role="radiogroup" is not allowed on <fieldset>, so the radio group is a div whose visible
        // label (same markup as a legend) names it via aria-labelledby.
        return (
          <div
            className={cx(fieldClass, "field-group")}
            role="radiogroup"
            aria-labelledby={labelId}
            aria-required={def.required ? true : undefined}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={describedBy}
            data-testid={testid}
          >
            <div className={cx("group-legend")}>
              <span id={labelId} className={cx("field-label")}>
                {def.label}
              </span>
              {def.required && <Req />}
            </div>
            {hintEl}
            {choices}
            {errorEl}
          </div>
        );
      }
      return (
        <fieldset
          className={cx(fieldClass, "field-group")}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          data-testid={testid}
        >
          {legend}
          {hintEl}
          {choices}
          {errorEl}
        </fieldset>
      );
    }

    case "combobox":
      return (
        <div className={fieldClass}>
          {labelRow}
          <Combobox
            def={def}
            id={id}
            labelId={labelId}
            value={str}
            onChange={onChange}
            invalid={invalid}
            describedBy={describedBy}
          />
          {hintEl}
          {errorEl}
        </div>
      );

    case "file":
      return (
        <div className={fieldClass}>
          {labelRow}
          <div className={cx("upload", file && "has-file")}>
            <input
              {...common}
              ref={fileInput}
              type="file"
              accept={def.accept}
              className={cx("visually-hidden")}
              onChange={(e) => onFile?.(e.target.files?.[0] ?? null)}
            />
            <span className={cx("upload-icon")}>
              <IconFile />
            </span>
            <div className={cx("upload-meta")}>
              {file ? (
                <>
                  <span className={cx("upload-name")}>{file.name}</span>
                  <span className={cx("upload-sub")}>{formatBytes(file.size)} · ready to upload</span>
                </>
              ) : (
                <>
                  <span className={cx("upload-name", "is-empty")}>No file chosen</span>
                  <span className={cx("upload-sub")}>PDF only</span>
                </>
              )}
            </div>
            <button
              type="button"
              className={cx("btn", "btn-secondary", "btn-sm")}
              aria-label={`${file ? "Replace" : "Choose"} file for ${def.label}`}
              data-testid={M.testid(`${def.testid}-button`)}
              onClick={() => fileInput.current?.click()}
            >
              {file ? "Replace" : "Choose file"}
            </button>
            {file && (
              <button
                type="button"
                className={cx("btn", "btn-ghost", "btn-sm")}
                aria-label={`Remove ${file.name}`}
                data-testid={M.testid(`${def.testid}-remove`)}
                onClick={() => {
                  if (fileInput.current) fileInput.current.value = "";
                  onFile?.(null);
                }}
              >
                Remove
              </button>
            )}
          </div>
          {hintEl}
          {errorEl}
        </div>
      );

    case "textarea":
      return (
        <div className={fieldClass}>
          {labelRow}
          <textarea
            {...common}
            rows={def.rows ?? 4}
            className={cx("input", "textarea")}
            placeholder={def.placeholder}
            value={str}
            onChange={(e) => onChange(e.target.value)}
          />
          {hintEl}
          {errorEl}
        </div>
      );

    default:
      return (
        <div className={fieldClass}>
          {labelRow}
          <input
            {...common}
            type={inputType(def.kind)}
            inputMode={def.inputMode}
            className={cx("input")}
            placeholder={def.placeholder}
            autoComplete="off"
            spellCheck={false}
            value={str}
            onChange={(e) => onChange(e.target.value)}
          />
          {hintEl}
          {errorEl}
        </div>
      );
  }
}

export interface FormSectionProps {
  section: SectionDef;
  values: FormValues;
  errors: Record<string, string>;
  onChange(key: string, value: RawValue): void;
  files?: Record<string, File | null>;
  onFile?(key: string, file: File | null): void;
  vars?: Record<string, string>;
}

export function FormSection({ section, values, errors, onChange, files, onFile, vars }: FormSectionProps) {
  if (!conditionHolds(section.showWhen, values)) return null;
  const fields = section.fields.filter((f) => conditionHolds(f.showWhen, values));
  const titleId = M.id(`section-${section.key}-title`);
  const grid = (
    <div className={cx("grid", section.columns === 2 ? "cols-2" : "cols-1")}>
      {fields.map((f) => (
        <Wrap key={f.key} k={`field:${f.key}`}>
          <FieldView
            def={f}
            value={values[f.key]}
            error={errors[f.key]}
            onChange={(v) => onChange(f.key, v)}
            file={files?.[f.key] ?? null}
            onFile={(file) => onFile?.(f.key, file)}
            vars={vars}
          />
        </Wrap>
      ))}
    </div>
  );
  const description = section.description ? (
    <p className={cx("section-desc")}>{fillVars(section.description, vars)}</p>
  ) : null;
  const content = section.fieldset ? (
    <fieldset className={cx("form-section", "section-fieldset")}>
      <legend className={cx("section-title")} id={titleId}>
        {section.title}
      </legend>
      {description}
      {grid}
    </fieldset>
  ) : (
    <section className={cx("form-section")} aria-labelledby={section.title ? titleId : undefined}>
      {section.title && (
        <h2 className={cx("section-title")} id={titleId}>
          {section.title}
        </h2>
      )}
      {description}
      {grid}
    </section>
  );
  return <Wrap k={`section:${section.key}`}>{content}</Wrap>;
}

export interface ErrorItem {
  key: string;
  message: string;
}

export function errorItems(
  sections: readonly SectionDef[],
  values: FormValues,
  errors: Record<string, string>,
): ErrorItem[] {
  const items: ErrorItem[] = [];
  const seen = new Set<string>();
  for (const f of visibleFields(sections, values)) {
    const message = errors[f.key];
    if (message) {
      items.push({ key: f.key, message });
      seen.add(f.key);
    }
  }
  for (const [key, message] of Object.entries(errors)) if (!seen.has(key)) items.push({ key, message });
  return items;
}

export function ErrorSummary({
  title,
  items,
  testid,
  ref,
}: {
  title: string;
  items: ErrorItem[];
  testid?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const titleId = M.id("error-summary-title");
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-labelledby={titleId}
      className={cx("alert", "alert-error", "error-summary")}
      data-testid={testid}
    >
      <span className={cx("alert-icon")}>
        <IconAlert size={20} />
      </span>
      <div>
        <p id={titleId} className={cx("alert-title")}>
          {title}
        </p>
        <ul className={cx("alert-list")}>
          {items.map((i) => (
            <li key={i.key}>{i.message}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ActionButton({
  actionKey,
  text,
  synonyms,
  testid,
  type = "button",
  variant = "primary",
  busy = false,
  busyText = "Submitting…",
  onClick,
  icon,
}: {
  actionKey: string;
  text: string;
  synonyms: readonly string[];
  /** Base testid; dropped when button_rename applies. */
  testid?: string;
  type?: "button" | "submit";
  variant?: "primary" | "secondary";
  busy?: boolean;
  busyText?: string;
  onClick?: () => void;
  icon?: ReactNode;
}) {
  const action = M.action(actionKey, text, synonyms);
  return (
    <button
      type={type}
      className={cx("btn", `btn-${variant}`)}
      data-testid={action.keepTestid && testid ? M.testid(testid) : undefined}
      disabled={busy}
      aria-busy={busy ? true : undefined}
      onClick={onClick}
    >
      {busy ? (
        <>
          <span className={cx("spinner")} aria-hidden="true" />
          {busyText}
        </>
      ) : (
        <>
          {icon}
          {action.text}
        </>
      )}
    </button>
  );
}

export interface ReadbackItem {
  key: string;
  label: string;
  value: FieldValue | undefined;
  def?: Pick<FieldDef, "kind">;
  /** Overrides the default display text (e.g. file names). */
  display?: string;
}

/**
 * Read-back for verifiers: one <dt>/<dd> pair per field; each <dd> carries data-field="<canonicalKey>"
 * and data-value="<canonical value>" (ISO dates, JSON arrays). These attributes are never mutated.
 */
export function ReadbackList({ items, testid }: { items: ReadbackItem[]; testid?: string }) {
  return (
    <dl className={cx("kv")} data-testid={testid}>
      {items.map((it) => (
        <div className={cx("kv-row")} key={it.key}>
          <dt className={cx("kv-label")}>{it.label}</dt>
          <dd className={cx("kv-value")} data-field={it.key} data-value={canonicalString(it.value)}>
            {it.display ?? displayValue(it.def, it.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Raw values of the currently visible, non-file fields, keyed by canonical key. */
export function payloadFor(sections: readonly SectionDef[], values: FormValues): Record<string, RawValue> {
  const out: Record<string, RawValue> = {};
  for (const f of visibleFields(sections, values)) {
    if (f.kind !== "file") out[f.key] = values[f.key] ?? emptyValueFor(f);
  }
  return out;
}

export function Footer() {
  return (
    <footer className={cx("demo-footer")}>
      <span>Demo software. Fictional companies and data.</span>
    </footer>
  );
}
