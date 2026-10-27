// Supplier Portal styles. Tenant brand colors are injected as custom properties on the app root.

export const SUPPLIER_CSS = `
:root{
--font:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
--text:#1d2533;--text-2:#3b4556;--heading:#111827;--label:#273142;--muted:#5f6b7a;--placeholder:#9aa4b2;
--border:#e1e5eb;--border-strong:#cbd2db;--border-hover:#a9b3c0;--divider:#eef1f4;
--bg:#f4f6f8;--input-bg:#fff;--upload-bg:#f9fafb;--hover-bg:#f5f7f9;
--primary:#2456d6;--primary-hover:#1c46b3;--primary-contrast:#fff;--primary-tint:#edf2fe;--primary-ink:#13306f;
--focus-ring:rgba(36,86,214,.28);--link:#2456d6;
--error:#c0262d;--error-bg:#fff4f3;--error-border:#f5c8c5;--error-text:#6e1b16;--error-input-bg:#fffbfb;--error-ring:rgba(192,38,45,.18);
--radius:10px;--radius-sm:7px;--input-h:38px
}
.sg{min-height:100vh;display:flex;flex-direction:column}
.card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 1px 2px rgba(16,24,40,.05)}
.sg-top{background:#fff;border-top:4px solid var(--primary);border-bottom:1px solid var(--border)}
.sg-top-inner{max-width:1040px;margin:0 auto;padding:0 28px;height:60px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.tenant{display:flex;align-items:center;gap:12px;color:var(--heading)}
.tenant-line{display:flex;align-items:baseline;gap:8px;font-size:16px;line-height:1.2}
.tenant-name{font-weight:700}
.tenant-dot{color:var(--placeholder)}
.tenant-sub{font-weight:500;color:var(--text-2)}
.top-help{font-size:13px;color:var(--muted)}
.top-help strong{color:var(--text-2);font-weight:600}
.sg-main{flex:1;width:100%;max-width:1040px;margin:0 auto;padding:18px 28px 0}

.stepper-card{margin-bottom:14px}
.stepper{display:flex;align-items:center;list-style:none;margin:0;padding:12px 20px}
.step{display:flex;align-items:center;flex:1;min-width:0}
.step:last-child{flex:none}
.step-btn{display:flex;align-items:center;gap:9px;padding:2px;border:0;background:none;color:inherit;font:inherit;text-align:left;border-radius:6px}
.step-btn:disabled{cursor:default}
.step-btn:not(:disabled):hover .step-label{color:var(--primary)}
.step-dot{width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:50%;border:2px solid var(--border-strong);background:#fff;color:var(--muted);font-size:12px;font-weight:700}
.step-label{font-size:13px;font-weight:600;color:var(--muted);white-space:nowrap}
.step-line{flex:1;height:2px;min-width:12px;margin:0 12px;background:var(--border)}
.step.is-done .step-dot{background:var(--primary);border-color:var(--primary);color:#fff}
.step.is-done .step-label{color:var(--text)}
.step.is-done .step-line{background:var(--primary)}
.step.is-current .step-dot{border-color:var(--primary);color:var(--primary);box-shadow:0 0 0 4px var(--primary-tint)}
.step.is-current .step-label{color:var(--heading)}

.wizard-card{padding:22px 28px 0}
.step-head{margin-bottom:18px}
.eyebrow{margin-bottom:4px;font-size:12px;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:.6px}
.step-title{font-size:21px;line-height:1.25;font-weight:700;color:var(--heading)}
.step-desc{margin-top:4px;font-size:14px;color:var(--muted)}
.wizard-card .form-section{margin-bottom:20px}
.wizard-card .section-title{padding-top:2px}
.wizard-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px -28px 0;padding:14px 28px;border-top:1px solid var(--divider);background:#fafbfc;border-radius:0 0 var(--radius) var(--radius)}
.actions-right{display:flex;align-items:center;gap:14px;margin-left:auto}
.save-note{font-size:12px;color:var(--muted)}

.invite{max-width:700px;margin:26px auto 0;padding:32px 36px}
.invite-title{margin-top:18px;font-size:24px;line-height:1.3;font-weight:700;color:var(--heading)}
.invite-text{margin-top:8px;font-size:15px;color:var(--text-2)}
.invite-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:22px 0 20px;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background:#fafbfc}
.meta-label{font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.meta-value{margin-top:3px;font-weight:600;color:var(--heading)}
.check-title{font-size:14px;font-weight:650;color:var(--heading);margin-bottom:8px}
.checklist{list-style:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px;margin:0 0 24px;font-size:14px;color:var(--text-2)}
.checklist li{display:flex;align-items:center;gap:8px}
.checklist svg{flex:none;color:var(--primary)}
.invite-actions{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.invite-actions .btn{height:42px;padding:0 22px;font-size:15px}
.invite-alert{margin-bottom:16px}

.review-section{padding:14px 0 8px;border-top:1px solid var(--divider)}
.review-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:2px}
.review-title{font-size:15px;font-weight:650;color:var(--heading)}
.review-note{display:flex;align-items:flex-start;gap:10px;margin:14px 0 20px;padding:13px 16px;border-radius:8px;background:var(--primary-tint);color:var(--primary-ink);font-size:13.5px}
.review-note svg{flex:none;margin-top:1px}

.success{max-width:720px;margin:26px auto 0;padding:32px 36px}
.success-icon{width:52px;height:52px;display:flex;align-items:center;justify-content:center;margin-bottom:16px;border-radius:50%;background:#e9f8ef;color:#0b7a43}
.success-title{font-size:24px;font-weight:700;color:var(--heading)}
.success-text{margin-top:6px;font-size:15px;color:var(--text-2)}
.success-ids{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px;margin:22px 0;padding:18px 20px;border:1px solid var(--border);border-radius:8px;background:#fafbfc}
.id-label{margin-bottom:4px;font-size:11.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.id-value{font-size:20px;font-weight:700;color:var(--heading);letter-spacing:.3px;font-variant-numeric:tabular-nums}
.next-title{font-size:15px;font-weight:650;color:var(--heading);margin-bottom:8px}
.next-list{padding-left:20px;color:var(--text-2);display:flex;flex-direction:column;gap:6px}

.login-wrap{display:flex;justify-content:center;padding-top:30px}
.login-card{width:420px;padding:30px 32px 28px}
.login-title{margin-top:16px;font-size:20px;font-weight:700;color:var(--heading)}
.login-sub{margin:4px 0 20px;font-size:13px;color:var(--muted)}
.login-form{display:flex;flex-direction:column;gap:16px}
.login-form .btn{width:100%;height:40px}

.home{max-width:640px;margin:70px auto 0;padding:36px 40px;text-align:center}
.home-title{font-size:24px;font-weight:700;color:var(--heading);margin-bottom:8px}
.home-text{color:var(--text-2);font-size:15px}
.home-top{background:#fff;border-bottom:1px solid var(--border)}
.home-top-inner{max-width:1040px;margin:0 auto;padding:0 28px;height:60px;display:flex;align-items:center;gap:10px;font-weight:700;color:var(--heading)}
.notfound{max-width:640px;margin:40px auto 0;padding:36px;text-align:center}
.notfound h1{font-size:22px;margin-bottom:8px}
`;
