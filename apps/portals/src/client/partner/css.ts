// Caravela Partner Hub styles. v1 = classic top-bar portal, v2 = sidebar redesign.

export const PARTNER_CSS = `
:root{
--font:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
--text:#172331;--text-2:#3a4757;--heading:#0e1b29;--label:#2a3747;--muted:#5f6c7b;--placeholder:#98a3b1;
--border:#dde3ea;--border-strong:#c7d0da;--border-hover:#a6b2c0;--divider:#edf1f5;
--bg:#f2f5f8;--input-bg:#fff;--upload-bg:#fafbfc;--hover-bg:#f5f7fa;
--primary:#0c5f8a;--primary-hover:#094c6f;--primary-contrast:#fff;--primary-tint:#e7f1f7;--primary-ink:#094c6f;
--focus-ring:rgba(12,95,138,.24);--link:#0c5f8a;
--navy:#0b3048;--amber:#e9a23b;
--error:#c0262d;--error-bg:#fff4f3;--error-border:#f5c8c5;--error-text:#6e1b16;--error-input-bg:#fffbfb;--error-ring:rgba(192,38,45,.18);
--radius:10px;--radius-sm:6px;--input-h:38px
}

.app{min-height:100vh;display:flex;flex-direction:column}
.app-main{flex:1}
.card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 1px 2px rgba(16,24,40,.05)}
.crumbs{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);margin-bottom:8px}
.crumbs a{color:var(--link);text-decoration:none;font-weight:600}
.crumbs a:hover{text-decoration:underline}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:20px}
.page-title{font-size:24px;line-height:1.25;font-weight:700;color:var(--heading);letter-spacing:-.2px}
.page-sub{margin-top:4px;font-size:14px;color:var(--muted)}

.topbar{background:var(--navy);color:#fff}
.topbar-inner{max-width:1080px;margin:0 auto;padding:0 32px;height:58px;display:flex;align-items:center;gap:26px}
.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none}
.brand-name{font-size:16px;font-weight:700;letter-spacing:.1px}
.brand-sub{font-size:13px;font-weight:500;color:#a8c0d2;padding-left:10px;border-left:1px solid rgba(255,255,255,.25)}
.topnav{display:flex;align-self:stretch}
.topnav-link{display:flex;align-items:center;padding:0 12px;border-top:3px solid transparent;border-bottom:3px solid transparent;color:#cddfeb;font-weight:600;font-size:14px;text-decoration:none}
.topnav-link:hover{color:#fff}
.topnav-link.is-active{color:#fff;border-bottom-color:var(--amber)}
.topbar-user{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px;color:#cddfeb}
.org{display:flex;flex-direction:column;align-items:flex-end;line-height:1.2}
.org-name{color:#fff;font-weight:600}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--amber);color:var(--navy);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:none}
.signout{height:30px;padding:0 10px;border:1px solid rgba(255,255,255,.28);border-radius:6px;background:transparent;color:#fff;font-size:13px;font-weight:600}
.signout:hover{background:rgba(255,255,255,.1)}

.page{max-width:1080px;width:100%;margin:0 auto;padding:22px 32px 8px}
.form-layout{display:grid;grid-template-columns:minmax(0,1fr) 296px;gap:24px;align-items:start}
.form-card{padding:26px 30px 24px}
.form-card .form-section{padding-bottom:22px;margin-bottom:22px;border-bottom:1px solid var(--divider)}
.form-actions{display:flex;justify-content:flex-end;align-items:center;gap:12px}
.form-note{margin-right:auto;font-size:12px;color:var(--muted)}
.aside{display:flex;flex-direction:column;gap:16px;position:sticky;top:20px}
.aside-card{padding:18px 20px}
.aside-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;color:var(--heading);margin-bottom:10px}
.aside-title svg{color:var(--primary)}
.aside-list{list-style:none;display:flex;flex-direction:column;gap:9px;font-size:13px;color:var(--text-2)}
.aside-list li{display:flex;gap:8px;align-items:flex-start}
.aside-list svg{flex:none;margin-top:2px;color:#0b7a43}
.aside-text{font-size:13px;color:var(--text-2)}
.aside-text a{font-weight:600;text-decoration:none}

.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:20px}
.stat{padding:16px 18px}
.stat-label{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.stat-value{margin-top:6px;font-size:24px;font-weight:700;color:var(--heading);font-variant-numeric:tabular-nums}
.stat-note{margin-top:2px;font-size:12px;color:var(--muted)}
.table-card{overflow:hidden}
.table-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)}
.table-title{font-size:15px;font-weight:650;color:var(--heading)}
.table{width:100%;border-collapse:collapse;font-size:14px}
.table th{padding:10px 18px;background:#f8fafc;border-bottom:1px solid var(--border);text-align:left;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.table td{padding:12px 18px;border-bottom:1px solid var(--divider);vertical-align:middle}
.table tr:last-child td{border-bottom:0}
.table .num{text-align:right;font-variant-numeric:tabular-nums}
.table-link{color:var(--link);font-weight:600;text-decoration:none;font-variant-numeric:tabular-nums;white-space:nowrap}
.table-link:hover{text-decoration:underline}
.cell-main{font-weight:600;color:var(--heading)}
.cell-sub{display:block;font-size:12px;color:var(--muted)}
.empty{padding:28px;text-align:center;color:var(--muted)}

.confirm{display:flex;align-items:flex-start;gap:16px;padding:22px 24px;margin-bottom:20px}
.confirm-icon{width:44px;height:44px;border-radius:50%;background:#e9f8ef;color:#0b7a43;display:flex;align-items:center;justify-content:center;flex:none}
.confirm-title{font-size:22px;font-weight:700;color:var(--heading)}
.confirm-text{margin-top:4px;max-width:640px;color:var(--muted)}
.id-row{display:flex;align-items:flex-start;gap:32px;margin-top:16px;flex-wrap:wrap}
.id-label{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}
.id-value{font-size:20px;font-weight:700;color:var(--heading);letter-spacing:.3px;font-variant-numeric:tabular-nums}
.detail-card{padding:6px 24px 12px}
.detail-head{display:flex;align-items:center;justify-content:space-between;padding:14px 0 4px}
.detail-title{font-size:15px;font-weight:650;color:var(--heading)}
.detail-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:20px}

.login{flex:1;display:flex;align-items:flex-start;justify-content:center;padding:72px 16px 40px;background:linear-gradient(180deg,var(--navy) 0,var(--navy) 260px,var(--bg) 260px)}
.login-card{width:420px;padding:30px 32px 28px}
.login-brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.login-brand-name{font-size:17px;font-weight:700;color:var(--heading);line-height:1.15}
.login-brand-sub{font-size:13px;color:var(--muted)}
.login-title{font-size:20px;font-weight:700;color:var(--heading);margin-bottom:4px}
.login-sub{font-size:13px;color:var(--muted);margin-bottom:20px}
.login-form{display:flex;flex-direction:column;gap:16px}
.login-form .btn{width:100%;height:40px}
.login-foot{margin-top:18px;font-size:12px;color:var(--muted);text-align:center}

.notfound{padding:48px;text-align:center}
.notfound h1{font-size:22px;margin-bottom:8px}

.v2{--bg:#f6f7f9;--radius:12px;--radius-sm:8px;--input-h:40px;--primary:#1061a0;--primary-hover:#0c4f84;--primary-tint:#eaf2fa;--primary-ink:#0c4f84;--focus-ring:rgba(16,97,160,.22);--link:#1061a0;--border:#e3e7ec;--divider:#eef1f4}
.shell2{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:20px;padding:18px 14px;background:#fff;border-right:1px solid var(--border)}
.side-brand{display:flex;align-items:center;gap:10px;padding:2px 8px;color:var(--heading);text-decoration:none}
.side-brand-name{font-size:15px;font-weight:700;line-height:1.1}
.side-brand-sub{font-size:12px;color:var(--muted)}
.side-nav{display:flex;flex-direction:column;gap:2px}
.side-label{margin:6px 0 6px;padding:0 10px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.side-link{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:8px;color:var(--text-2);font-size:14px;font-weight:600;text-decoration:none}
.side-link:hover{background:var(--hover-bg)}
.side-link.is-active{background:var(--primary-tint);color:var(--primary-ink)}
.side-link.is-disabled{color:#9aa5b1;cursor:default}
.side-link.is-disabled:hover{background:transparent}
.side-foot{margin-top:auto;padding:12px;border:1px solid var(--border);border-radius:10px;font-size:12px;color:var(--muted)}
.side-foot strong{display:block;color:var(--heading);font-size:13px}
.main2{min-width:0;display:flex;flex-direction:column}
.header2{position:sticky;top:0;z-index:20;height:60px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 28px;background:rgba(255,255,255,.96);border-bottom:1px solid var(--border)}
.header2 .crumbs{margin:0}
.user2{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)}
.user2 .avatar{background:var(--primary-tint);color:var(--primary-ink)}
.signout2{height:32px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:#fff;font-size:13px;font-weight:600;color:var(--text)}
.signout2:hover{background:var(--hover-bg)}
.content2{flex:1;width:100%;max-width:1040px;padding:24px 28px 8px}
.v2 .page-title{font-size:22px}
.v2 .form-card{padding:24px 28px 22px}
.v2 .form-card .form-section{padding-bottom:20px;margin-bottom:20px}
.v2 .section-fieldset{padding:16px 18px 18px;border:1px solid var(--border);border-radius:10px;background:#fafbfc}
.v2 .section-fieldset .section-title{float:left;width:100%;margin-bottom:12px}
.v2 .section-fieldset .grid{clear:both}
.v2 .card{box-shadow:0 1px 3px rgba(16,24,40,.06)}
.v2 .table th{background:#fbfcfd}
`;
