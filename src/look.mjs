// The hub's shared look: one stylesheet, the header and the footer, inlined into every public page (the pages' CSP
// allows inline styles only, so there is no separate .css file). No scripts and no outside fonts.

export const LOGO = `<svg class="logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
<rect x="10" y="6" width="28" height="6" rx="2" fill="currentColor"/><rect x="10" y="36" width="28" height="6" rx="2" fill="currentColor"/>
<rect x="14" y="12" width="20" height="24" fill="var(--thread)"/>
<path d="M14 16h20M14 20h20M14 24h20M14 28h20M14 32h20" stroke="rgba(0,0,0,.18)" stroke-width="1.4"/>
<path d="M34 22c6 0 8 4 6 8s-6 8-12 10" fill="none" stroke="var(--thread)" stroke-width="2" stroke-dasharray="3 3" stroke-linecap="round"/>
</svg>`;

// Small line icons for cards (24px grid, stroke follows the text color).
const ic = (d) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS = {
  book: ic(`<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M8 7h7M8 11h7"/>`),
  note: ic(`<path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M8 9h8M8 13h5"/>`),
  camera: ic(`<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`),
  parts: ic(`<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>`),
  shop: ic(`<path d="M3 9l2-5h14l2 5"/><path d="M4 9v11h16V9"/><path d="M3 9h18M9 20v-6h6v6"/>`),
  map: ic(`<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>`),
  key: ic(`<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l2 2M15 8l2 2"/>`),
  shield: ic(`<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>`),
};

export const LOOK_CSS = `
:root{color-scheme:light;--bg:#f6f3ee;--bg2:#efe9df;--card:#fff;--ink:#1c2430;--muted:#5b6573;--line:#e0d9cd;--accent:#1f3a5f;--accent2:#2d5488;--on-accent:#fff;--thread:#c2553d;--gold:#c9952b;--bad:#b3261e;--ok:#1e7a3c;--shadow:0 1px 2px rgba(28,36,48,.06),0 6px 20px rgba(28,36,48,.07);--shadow-up:0 2px 4px rgba(28,36,48,.08),0 14px 34px rgba(28,36,48,.12);--warn-bg:#fff4d6;--warn-line:#d9a400;--warn-ink:#5a4300}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#14171c;--bg2:#1a1e25;--card:#1f242c;--ink:#e8ebef;--muted:#a3acb8;--line:#333a44;--accent:#8fb3e0;--accent2:#a9c6ea;--on-accent:#10213a;--thread:#e07a60;--gold:#e0b45a;--bad:#ff8a80;--ok:#7dd3a0;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.25);--shadow-up:0 2px 4px rgba(0,0,0,.35),0 14px 34px rgba(0,0,0,.35);--warn-bg:#3a3014;--warn-line:#b38900;--warn-ink:#ffe299}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#14171c;--bg2:#1a1e25;--card:#1f242c;--ink:#e8ebef;--muted:#a3acb8;--line:#333a44;--accent:#8fb3e0;--accent2:#a9c6ea;--on-accent:#10213a;--thread:#e07a60;--gold:#e0b45a;--bad:#ff8a80;--ok:#7dd3a0;--warn-bg:#3a3014;--warn-line:#b38900;--warn-ink:#ffe299}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column}
h1,h2,h3,.brand{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;letter-spacing:-.01em}
h1{font-size:clamp(28px,5vw,36px);line-height:1.2;margin:0 0 8px}
h2{font-size:22px;line-height:1.3;margin:0 0 10px}
h3{font-size:18px;margin:0 0 6px}
a{color:var(--accent);text-underline-offset:3px}
a:hover{color:var(--accent2)}
:focus-visible{outline:3px solid var(--gold);outline-offset:2px;border-radius:4px}
main{width:100%;max-width:760px;margin:0 auto;padding:28px 16px 64px;flex:1;overflow-wrap:anywhere}
.muted{color:var(--muted)}.bad{color:var(--bad)}.ok{color:var(--ok)}

/* header and footer */
.top{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;backdrop-filter:saturate(1.4) blur(8px)}
.top .in{max-width:960px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:700;color:var(--ink);text-decoration:none}
.brand:hover{color:var(--ink)}
.logo{width:36px;height:36px;color:var(--accent);flex:none;transition:transform .5s cubic-bezier(.2,.8,.2,1)}
.brand:hover .logo{transform:rotate(-12deg)}
.top nav{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
.top nav a{padding:8px 14px;border-radius:999px;text-decoration:none;color:var(--ink);font-weight:500}
.top nav a:hover{background:var(--bg2)}
.top nav a[aria-current="page"]{background:var(--accent);color:var(--on-accent)}
.foot{border-top:1px solid var(--line);background:var(--bg2);font-size:15px;color:var(--muted)}
.foot .in{max-width:960px;margin:0 auto;padding:22px 16px;display:flex;gap:10px 22px;flex-wrap:wrap;align-items:center}
.foot a{color:var(--muted)}.foot a:hover{color:var(--ink)}
.foot .stitch{flex-basis:100%;height:0;border-top:2px dashed var(--line);margin:0 0 6px}

/* cards, sections, forms */
section,article,.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:18px 0;box-shadow:var(--shadow)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
label{display:block;margin:12px 0 4px;color:var(--muted);font-size:15px;font-weight:500}
input,button,select,textarea{font:inherit;padding:11px 14px;border-radius:10px;border:1.5px solid var(--line);background:var(--card);color:var(--ink)}
input,select,textarea{width:100%;max-width:400px;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 18%,transparent);outline:none}
input[type=checkbox],input[type=radio]{width:auto}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;padding:11px 22px;margin-top:12px;border-radius:999px;border:0;background:var(--accent);color:var(--on-accent);font-weight:600;text-decoration:none;cursor:pointer;box-shadow:0 2px 6px color-mix(in srgb,var(--accent) 30%,transparent);transition:transform .15s,box-shadow .15s,background .15s}
button:hover,.button:hover{background:var(--accent2);color:var(--on-accent);transform:translateY(-1px);box-shadow:0 6px 16px color-mix(in srgb,var(--accent) 35%,transparent)}
button:active,.button:active{transform:translateY(0)}
button.plain,.button.plain{background:var(--card);color:var(--ink);border:1.5px solid var(--line);box-shadow:none}
button.plain:hover,.button.plain:hover{background:var(--bg2);color:var(--ink)}
button:disabled{opacity:.55;cursor:default;transform:none}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}
.check{display:flex;gap:10px;align-items:flex-start;margin:12px 0}.check input{width:22px;height:22px;margin-top:3px;flex:none}
.note{border-left:4px solid var(--accent);padding:8px 14px;background:var(--card);border-radius:0 10px 10px 0}
.draft{background:var(--warn-bg);color:var(--warn-ink);border:2px solid var(--warn-line);border-radius:12px;padding:12px 16px}
blockquote{margin:12px 0;padding:4px 14px;border-left:4px solid var(--line);color:var(--muted)}
code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
hr{border:0;border-top:2px dashed var(--line);margin:24px 0}

/* home page */
.hero{position:relative;overflow:hidden;color:#fff;background:radial-gradient(1200px 400px at 85% -10%,#3b6aa8 0,transparent 60%),linear-gradient(135deg,#1a3150 0%,#1f3a5f 55%,#2a4f7d 100%)}
.hero .in{max-width:960px;margin:0 auto;padding:56px 16px 64px;position:relative}
.hero h1{font-size:clamp(32px,6vw,52px);max-width:16ch;margin-bottom:14px}
.hero p{font-size:clamp(18px,2.4vw,21px);max-width:38em;color:#dbe6f3;margin:0 0 8px}
.hero .button{background:#fff;color:#1f3a5f;margin-right:10px}
.hero .button:hover{background:#f3e9d7;color:#1f3a5f}
.hero .button.plain{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.55)}
.hero .button.plain:hover{background:rgba(255,255,255,.12);color:#fff}
.hero .seam{position:absolute;left:-5%;right:-5%;bottom:22px;height:2px;border-top:3px dashed rgba(255,255,255,.28);transform:rotate(-1.2deg)}
.hero .spool{position:absolute;right:4%;top:50%;width:min(30vw,240px);height:auto;transform:translateY(-50%);color:rgba(255,255,255,.9);opacity:.9;animation:bob 6s ease-in-out infinite}
.wide{max-width:960px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:-40px 0 8px;position:relative}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.stat b{display:block;font:700 30px/1.1 "Iowan Old Style",Georgia,serif;color:var(--accent)}
.stat span{color:var(--muted);font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin:18px 0}
.grid .card{margin:0;transition:transform .2s,box-shadow .2s}
.grid .card:hover{transform:translateY(-3px);box-shadow:var(--shadow-up)}
.icon{width:30px;height:30px}
.badge{display:inline-grid;place-items:center;width:52px;height:52px;border-radius:14px;background:color-mix(in srgb,var(--accent) 12%,var(--card));color:var(--accent);margin-bottom:10px}
.card:nth-child(3n+2) .badge{background:color-mix(in srgb,var(--thread) 14%,var(--card));color:var(--thread)}
.card:nth-child(3n) .badge{background:color-mix(in srgb,var(--gold) 18%,var(--card));color:color-mix(in srgb,var(--gold) 70%,var(--ink))}
.card p{margin:0;color:var(--muted)}
.steps{counter-reset:s;list-style:none;padding:0;margin:0}
.steps li{counter-increment:s;position:relative;padding:4px 0 14px 54px;min-height:44px}
.steps li::before{content:counter(s);position:absolute;left:0;top:0;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:var(--thread);color:#fff;font-weight:700}
.kicker{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--thread);font-weight:700;margin:34px 0 6px}

/* gentle motion, off when the reader asks for less */
.rise{animation:rise .6s cubic-bezier(.2,.8,.2,1) both}
.rise:nth-child(2){animation-delay:.07s}.rise:nth-child(3){animation-delay:.14s}.rise:nth-child(4){animation-delay:.21s}.rise:nth-child(5){animation-delay:.28s}.rise:nth-child(6){animation-delay:.35s}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes bob{0%,100%{transform:translateY(-50%) rotate(-3deg)}50%{transform:translateY(calc(-50% - 8px)) rotate(3deg)}}
@media (min-width:641px){.hero p{max-width:62%}}
@media (max-width:640px){.hero .spool{display:none}.hero .in{padding:40px 16px 60px}.top nav{margin-left:0}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media print{.top,.foot,.noprint{display:none}body{background:#fff}section,article,.card{box-shadow:none}}
`;

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// Where the code this hub runs can be had (AGPL-3.0: everyone who uses the hub may get it). SOURCE_URL is the repository
// (a hub running changed code points it at its own); on Railway the deployed commit is linked, so the code is what runs.
const SOURCE_REPO = (/^https?:\/\/\S+$/i.test(process.env.SOURCE_URL?.trim() ?? "") ? process.env.SOURCE_URL.trim() : "https://github.com/sitesentrix/stitchhub").replace(/\/+$/, "");
const COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ?? "";
export const SOURCE_URL = /^[0-9a-f]{7,64}$/i.test(COMMIT) ? `${SOURCE_REPO}/tree/${COMMIT}` : SOURCE_REPO;

// The bar at the top. `active` is the path of the current page; `nav: false` shows the name only (the shoppers' pages).
export function header(hubName, { active = "", nav = true } = {}) {
  const links = [
    ["/", "Home"],
    ["/account/manuals", "Manuals"],
    ["/account", "Your account"],
  ];
  const items = links.map(([href, text]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${text}</a>`).join("");
  return `<header class="top"><div class="in"><a class="brand" href="/">${LOGO}<span>${esc(hubName)}</span></a>${nav ? `<nav aria-label="Main">${items}</nav>` : ""}</div></header>`;
}

export function footer(hubName) {
  return `<footer class="foot"><div class="in"><span class="stitch" aria-hidden="true"></span><span>${esc(hubName)}, the community hub for StitchBench and StitchShop</span><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/copyright">Copyright</a><a href="${esc(SOURCE_URL)}">Source code</a></div></footer>`;
}

// A whole page: the shared look, then any page-specific CSS, then the header, the body and the footer.
export function shell({ hubName, title, body, css = "", active = "", nav = true, main = true }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${LOOK_CSS}${css}</style></head><body>
${header(hubName, { active, nav })}
${main ? `<main>${body}</main>` : body}
${footer(hubName)}
</body></html>`;
}
