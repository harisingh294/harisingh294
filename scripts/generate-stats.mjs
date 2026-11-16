// Generates live GitHub stats, streak and contribution-graph SVGs for the profile README.
// Runs in GitHub Actions (see .github/workflows/update-stats.yml). Node 20+, no dependencies.
import { mkdir, writeFile } from "node:fs/promises";

const USER = process.env.GH_USER || "harisingh294";
const TOKEN = process.env.GITHUB_TOKEN;
const TZ = "Asia/Kolkata";
const OUT = "assets";

if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-stats" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => n.toLocaleString("en-IN");
const fmtDate = (d, withYear) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  });

// ---------- fetch data ----------
const now = new Date();
const yearAgo = new Date(now.getTime() - 365 * 864e5);

const main = await gql(
  `query($login:String!,$from:DateTime!,$to:DateTime!){
    user(login:$login){
      name login createdAt
      followers{totalCount}
      repositories(ownerAffiliations:OWNER,isFork:false,first:100){totalCount nodes{stargazerCount}}
      contributionsCollection(from:$from,to:$to){
        totalCommitContributions totalPullRequestContributions totalIssueContributions
        totalPullRequestReviewContributions restrictedContributionsCount
        totalRepositoriesWithContributedCommits
        contributionCalendar{totalContributions weeks{contributionDays{date contributionCount weekday}}}
      }
    }}`,
  { login: USER, from: yearAgo.toISOString(), to: now.toISOString() }
);
const u = main.user;
const cc = u.contributionsCollection;

// All-time calendar, one year at a time (API limit), for total + streaks.
const days = new Map();
let start = new Date(u.createdAt);
while (start < now) {
  const end = new Date(Math.min(start.getTime() + 365 * 864e5, now.getTime()));
  const d = await gql(
    `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){
      contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`,
    { login: USER, from: start.toISOString(), to: end.toISOString() }
  );
  for (const w of d.user.contributionsCollection.contributionCalendar.weeks)
    for (const day of w.contributionDays) days.set(day.date, day.contributionCount);
  start = end;
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // YYYY-MM-DD in IST
const sorted = [...days.entries()].filter(([d]) => d <= today).sort(([a], [b]) => a.localeCompare(b));
const totalAll = sorted.reduce((s, [, c]) => s + c, 0);
const firstDay = sorted.find(([, c]) => c > 0)?.[0] ?? sorted[0][0];

// Longest streak
let longest = { len: 0, from: null, to: null };
let run = { len: 0, from: null };
for (const [d, c] of sorted) {
  if (c > 0) {
    run = run.len ? { len: run.len + 1, from: run.from } : { len: 1, from: d };
    if (run.len > longest.len) longest = { len: run.len, from: run.from, to: d };
  } else run = { len: 0, from: null };
}

// Current streak: today with 0 contributions doesn't break it yet.
let i = sorted.length - 1;
if (i >= 0 && sorted[i][1] === 0) i--;
let current = { len: 0, from: null, to: null };
if (i >= 0 && sorted[i][1] > 0) {
  current.to = sorted[i][0];
  while (i >= 0 && sorted[i][1] > 0) { current.len++; current.from = sorted[i][0]; i--; }
}

const stars = u.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
const updated = now.toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });

// ---------- SVG helpers ----------
const C = { bg: "#0d1117", border: "#30363d", title: "#22d3ee", text: "#c9d1d9", muted: "#8b949e", accent: "#a78bfa", fire: "#fb923c" };
const font = `font-family="'Segoe UI',Ubuntu,'Helvetica Neue',Sans-Serif"`;
const card = (w, h, body, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${C.bg}" stroke="${C.border}"/>
${body}
</svg>
`;

// ---------- stats card ----------
const rows = [
  ["Contributions (last year)", cc.contributionCalendar.totalContributions],
  ["Commits (last year)", cc.totalCommitContributions],
  ["Pull requests", cc.totalPullRequestContributions],
  ["Code reviews", cc.totalPullRequestReviewContributions],
  ["Issues", cc.totalIssueContributions],
  ["Repos contributed to", cc.totalRepositoriesWithContributedCommits],
  ["Stars earned", stars],
];
const statsBody = `<text x="25" y="38" ${font} font-size="18" font-weight="600" fill="${C.title}">${esc(u.name || u.login)}'s GitHub Stats</text>
${rows.map(([k, v], n) => `<text x="25" y="${72 + n * 25}" ${font} font-size="14" fill="${C.text}">${esc(k)}:</text>
<text x="300" y="${72 + n * 25}" ${font} font-size="14" font-weight="700" fill="${C.accent}">${fmt(v)}</text>`).join("\n")}
<text x="25" y="${72 + rows.length * 25 + 4}" ${font} font-size="11" fill="${C.muted}">Updated ${esc(updated)} IST</text>`;
const statsSvg = card(467, 72 + rows.length * 25 + 18, statsBody, `GitHub stats for ${u.login}`);

// ---------- streak card ----------
const range = (a, b) => (!a ? "—" : a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
const col = (x, value, label, sub, color, big) => `<text x="${x}" y="${big ? 83 : 88}" text-anchor="middle" ${font} font-size="${big ? 32 : 28}" font-weight="700" fill="${color}">${fmt(value)}</text>
<text x="${x}" y="125" text-anchor="middle" ${font} font-size="14" font-weight="600" fill="${C.text}">${esc(label)}</text>
<text x="${x}" y="147" text-anchor="middle" ${font} font-size="12" fill="${C.muted}">${esc(sub)}</text>`;
const streakBody = `<line x1="165" y1="35" x2="165" y2="160" stroke="${C.border}"/>
<line x1="330" y1="35" x2="330" y2="160" stroke="${C.border}"/>
${col(82, totalAll, "Total Contributions", `${fmtDate(firstDay, true)} – Present`, C.accent)}
<circle cx="247" cy="72" r="34" fill="none" stroke="${C.fire}" stroke-width="5"/>
${col(247, current.len, "Current Streak", range(current.from, current.to), C.fire, true)}
${col(412, longest.len, "Longest Streak", range(longest.from, longest.to), C.accent)}
<text x="247" y="182" text-anchor="middle" ${font} font-size="11" fill="${C.muted}">Updated ${esc(updated)} IST</text>`;
const streakSvg = card(495, 195, streakBody, `Contribution streak for ${u.login}: current ${current.len} days, longest ${longest.len} days`);

// ---------- contribution graph (last year) ----------
const weeks = cc.contributionCalendar.weeks;
const max = Math.max(1, ...weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)));
const shade = (c) => (c === 0 ? "#161b22" : ["#3b2a6b", "#5b3fb0", "#7c3aed", "#a78bfa"][Math.min(3, Math.floor(((c - 1) / max) * 4))]);
const cell = 11, gap = 3, left = 30, top = 52;
let cells = "", months = "", lastMonth = -1;
weeks.forEach((w, wi) => {
  const m = new Date(w.contributionDays[0].date + "T00:00:00Z").getUTCMonth();
  if (m !== lastMonth && wi < weeks.length - 2) {
    months += `<text x="${left + wi * (cell + gap)}" y="${top - 8}" ${font} font-size="10" fill="${C.muted}">${new Date(Date.UTC(2000, m, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })}</text>`;
    lastMonth = m;
  }
  for (const d of w.contributionDays)
    cells += `<rect x="${left + wi * (cell + gap)}" y="${top + d.weekday * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${shade(d.contributionCount)}"><title>${d.contributionCount} on ${d.date}</title></rect>`;
});
const gw = left + weeks.length * (cell + gap) + 15;
const graphBody = `<text x="${left}" y="22" ${font} font-size="13" font-weight="600" fill="${C.text}">${fmt(cc.contributionCalendar.totalContributions)} contributions in the last year</text>
${months}
${["Mon", "Wed", "Fri"].map((t, n) => `<text x="4" y="${top + (1 + n * 2) * (cell + gap) + 9}" ${font} font-size="9" fill="${C.muted}">${t}</text>`).join("")}
${cells}`;
const graphSvg = card(gw, top + 7 * (cell + gap) + 12, graphBody, `${u.login}'s contribution graph`);

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/github-stats.svg`, statsSvg);
await writeFile(`${OUT}/streak.svg`, streakSvg);
await writeFile(`${OUT}/contributions.svg`, graphSvg);
console.log({ lastYear: cc.contributionCalendar.totalContributions, restricted: cc.restrictedContributionsCount, totalAll, current, longest });
