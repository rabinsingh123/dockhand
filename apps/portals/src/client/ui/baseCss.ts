// Base styles shared by both portals. Class selectors are rewritten by class_churn at runtime, so
// keep every class selector a plain ".name" and never write ".word" inside values or comments.
// Colors come from custom properties that each portal defines.

export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{margin:0;padding:0}
body{font-family:var(--font);font-size:14px;line-height:1.45;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
h1,h2,h3,p,dl,dd,figure{margin:0}
ul,ol{margin:0;padding:0}
button,input,textarea{font:inherit;color:inherit}
button{cursor:pointer}
a{color:var(--link)}
:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;white-space:nowrap!important;border:0!important}
.muted{color:var(--muted)}

.form-section{border:0;margin:0;padding:0;min-width:0}
.section-title{font-size:15px;font-weight:650;color:var(--heading);padding:0;margin:0 0 4px}
.section-desc{font-size:13px;color:var(--muted);margin:0 0 14px}
.grid{display:grid;gap:16px 20px;align-items:start}
.cols-1{grid-template-columns:minmax(0,1fr)}
.cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.span-2{grid-column:1 / -1}

.field{position:relative;min-width:0;margin:0;padding:0;border:0}
.label-row{display:flex;align-items:baseline;gap:3px;margin-bottom:6px}
.field-label{font-size:13px;font-weight:600;color:var(--label);line-height:1.3}
.req{color:var(--error);font-weight:700;font-size:13px;line-height:1}
.field-hint{margin-top:6px;font-size:12px;color:var(--muted);line-height:1.4}
.field-error{display:flex;align-items:flex-start;gap:6px;margin-top:6px;font-size:12.5px;font-weight:500;color:var(--error);line-height:1.35}
.field-error svg{flex:none;margin-top:1px}

.input{display:block;width:100%;height:var(--input-h);padding:0 12px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--input-bg);font-size:14px;color:var(--text);transition:border-color .12s ease,box-shadow .12s ease}
.input::placeholder{color:var(--placeholder);opacity:1}
.input:hover{border-color:var(--border-hover)}
.input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--focus-ring)}
.textarea{height:auto;min-height:96px;padding:9px 12px;line-height:1.45;resize:vertical}
.has-error .input{border-color:var(--error);background:var(--error-input-bg)}
.has-error .input:focus{box-shadow:0 0 0 3px var(--error-ring)}

.combo{position:relative}
.combo-input{padding-right:38px}
.combo-chevron{position:absolute;right:11px;top:0;height:var(--input-h);display:flex;align-items:center;color:var(--muted);pointer-events:none}
.combo-popup{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:40;background:#fff;border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:0 14px 32px rgba(16,24,40,.16),0 3px 8px rgba(16,24,40,.08);overflow:hidden}
.combo-popup.is-up{top:auto;bottom:calc(100% + 4px)}
.combo-list{position:relative;list-style:none;margin:0;padding:4px;max-height:252px;overflow-y:auto}
.combo-option{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:6px;font-size:14px;cursor:pointer;color:var(--text)}
.combo-option.is-active{background:var(--primary-tint)}
.combo-option.is-selected{font-weight:600;color:var(--primary)}
.combo-empty{padding:12px;font-size:13px;color:var(--muted)}

.group-legend{display:flex;align-items:baseline;gap:3px;padding:0;margin-bottom:6px}
.choice-row{display:flex;flex-wrap:wrap;gap:6px}
.choice{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 11px 0 9px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--input-bg);font-size:13.5px;cursor:pointer;user-select:none;transition:border-color .12s ease,background-color .12s ease}
.choice:hover{border-color:var(--border-hover)}
.choice.is-checked{border-color:var(--primary);background:var(--primary-tint);color:var(--primary-ink)}
.choice-input{margin:0;width:16px;height:16px;flex:none;accent-color:var(--primary);cursor:pointer}
.has-error .choice{border-color:var(--error)}
.field-group .field-hint{margin:0 0 8px}

.check-row{display:flex;align-items:flex-start;gap:3px}
.check{display:inline-flex;align-items:flex-start;gap:10px;font-size:14px;line-height:1.4;cursor:pointer;color:var(--text)}
.check-input{margin:1px 0 0;width:17px;height:17px;flex:none;accent-color:var(--primary);cursor:pointer}
.has-error .check-input{outline:2px solid var(--error);outline-offset:1px}
.field .check-row+.field-hint{margin-left:27px}
.field .check-row~.field-error{margin-left:27px}

.upload{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px dashed var(--border-strong);border-radius:var(--radius-sm);background:var(--upload-bg)}
.upload.has-file{border-style:solid;background:#fff}
.has-error .upload{border-color:var(--error)}
.upload-icon{display:flex;color:var(--primary);flex:none}
.upload-meta{display:flex;flex-direction:column;min-width:0;flex:1}
.upload-name{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.upload-name.is-empty{font-weight:500;color:var(--muted)}
.upload-sub{font-size:12px;color:var(--muted)}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:38px;padding:0 16px;border:1px solid transparent;border-radius:var(--radius-sm);font-size:14px;font-weight:600;line-height:1;white-space:nowrap;text-decoration:none;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}
.btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus-ring)}
.btn:disabled{cursor:progress;opacity:.8}
.btn-primary{background:var(--primary);color:var(--primary-contrast)}
.btn-primary:hover:not(:disabled){background:var(--primary-hover)}
.btn-secondary{background:#fff;border-color:var(--border-strong);color:var(--text)}
.btn-secondary:hover:not(:disabled){background:var(--hover-bg);border-color:var(--border-hover)}
.btn-ghost{background:transparent;color:var(--muted)}
.btn-ghost:hover{background:var(--hover-bg);color:var(--text)}
.btn-link{height:auto;padding:0;border:0;background:none;color:var(--primary);font-weight:600}
.btn-link:hover{text-decoration:underline}
.btn-sm{height:32px;padding:0 12px;font-size:13px}
.spinner{display:inline-block;width:15px;height:15px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.alert{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border:1px solid;border-radius:var(--radius-sm);font-size:14px}
.alert-icon{display:flex;flex:none;margin-top:1px}
.alert-error{background:var(--error-bg);border-color:var(--error-border);color:var(--error-text)}
.alert-error .alert-icon{color:var(--error)}
.alert-title{font-weight:700;margin-bottom:4px}
.alert-list{margin:0;padding-left:18px}
.alert-list li{margin:2px 0}
.error-summary{margin-bottom:22px}
.error-summary:focus{outline:none;box-shadow:0 0 0 3px var(--error-ring)}

.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge-pending{background:#fff6e5;color:#a15c07}
.badge-approved{background:#e9f8ef;color:#0b7a43}
.badge-declined{background:#fdeeee;color:#b42318}
.badge-expired{background:#f1f3f6;color:#4b5565}

.kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 28px}
.kv-row{display:grid;grid-template-columns:minmax(0,44%) minmax(0,1fr);gap:12px;padding:10px 0;border-bottom:1px solid var(--divider)}
.kv-label{font-size:13px;color:var(--muted)}
.kv-value{font-size:14px;font-weight:500;color:var(--text);overflow-wrap:anywhere;white-space:pre-wrap}
.kv-value:empty::before{content:"Not provided";color:var(--placeholder);font-weight:400}

.demo-footer{padding:18px 0 22px;text-align:center;font-size:12px;color:var(--muted)}

@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:0s!important;animation-iteration-count:1!important;transition:none!important;scroll-behavior:auto!important}}
`;
