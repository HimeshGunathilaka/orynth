// Renders the README diagrams to docs/images/<name>-{light,dark}.png (2x), from the SVG built below.
// Usage: node scripts/diagrams.mjs   (needs Playwright's Chromium: npx playwright install chromium)
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const out = path.resolve(import.meta.dirname, "../docs/images");

const THEMES = {
  light: {
    bg: "#ffffff",
    text: "#1f2328",
    muted: "#59636e",
    line: "#d0d7de",
    edge: "#818b98",
    card: "#f6f8fa",
    blue: { fill: "#ddf4ff", stroke: "#54aeff", ink: "#0969da" },
    green: { fill: "#dafbe1", stroke: "#4ac26b", ink: "#1a7f37" },
    amber: { fill: "#fff8c5", stroke: "#d4a72c", ink: "#9a6700" },
    red: { fill: "#ffebe9", stroke: "#ff8182", ink: "#cf222e" },
    gray: { fill: "#f6f8fa", stroke: "#afb8c1", ink: "#59636e" },
  },
  dark: {
    bg: "#0d1117",
    text: "#e6edf3",
    muted: "#9198a1",
    line: "#3d444d",
    edge: "#6e7681",
    card: "#151b23",
    blue: { fill: "#0c2d6b", stroke: "#1f6feb", ink: "#58a6ff" },
    green: { fill: "#033a16", stroke: "#238636", ink: "#3fb950" },
    amber: { fill: "#3b2300", stroke: "#9e6a03", ink: "#d29922" },
    red: { fill: "#4b1113", stroke: "#da3633", ink: "#f85149" },
    gray: { fill: "#151b23", stroke: "#3d444d", ink: "#9198a1" },
  },
};

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Sublabels written as `code` are set in the monospace font.
const isCode = (s) => s.startsWith("`") && s.endsWith("`");

/** A rounded box: a title, sublabel lines and an optional chip, centred. */
function box(t, { x, y, w, h, tone, title, mono = false, sub = [], chip, step }) {
  const c = t[tone];
  const cx = x + w / 2;
  const lines = [];
  // Title, sublabels and chip as one block, centred vertically.
  const height = 14 + sub.length * 17 + (chip ? 30 : 0);
  const top = y + (h - height) / 2 + 13;
  lines.push(
    `<text x="${cx}" y="${top}" text-anchor="middle" font-family="${mono ? MONO : SANS}" font-size="16" font-weight="600" fill="${t.text}">${esc(title)}</text>`,
  );
  sub.forEach((s, i) =>
    lines.push(
      `<text x="${cx}" y="${top + 21 + i * 17}" text-anchor="middle" font-family="${isCode(s) ? MONO : SANS}" font-size="${isCode(s) ? 11.5 : 12.5}" fill="${t.muted}">${esc(isCode(s) ? s.slice(1, -1) : s)}</text>`,
    ),
  );
  if (chip) {
    const cw = chip.length * 6.6 + 20;
    const cy = top + 21 + (sub.length - 1) * 17 + 13;
    lines.push(
      `<rect x="${cx - cw / 2}" y="${cy}" width="${cw}" height="19" rx="9.5" fill="${t.bg}" stroke="${c.stroke}"/>`,
      `<text x="${cx}" y="${cy + 13.5}" text-anchor="middle" font-family="${SANS}" font-size="11.5" fill="${c.ink}">${esc(chip)}</text>`,
    );
  }
  if (step !== undefined)
    lines.push(
      `<circle cx="${x + 2}" cy="${y + 2}" r="12" fill="${c.ink}"/>`,
      `<text x="${x + 2}" y="${y + 6.5}" text-anchor="middle" font-family="${SANS}" font-size="12.5" font-weight="700" fill="${t.bg}">${step}</text>`,
    );
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>\n${lines.join("\n")}`;
}

/** An arrow along points, with an optional label on a background at `at`. */
function arrow(t, points, { label, at, dashed = false, color } = {}) {
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const stroke = color ?? t.edge;
  let svg = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8"${dashed ? ' stroke-dasharray="6 5"' : ""} marker-end="url(#head-${stroke.slice(1)})"/>`;
  if (label) {
    const [lx, ly] = at;
    const lw = label.length * 6.9 + 14;
    svg += `\n<rect x="${lx - lw / 2}" y="${ly - 11}" width="${lw}" height="20" rx="4" fill="${t.bg}"/>`;
    svg += `\n<text x="${lx}" y="${ly + 3.5}" text-anchor="middle" font-family="${SANS}" font-size="12.5" fill="${t.muted}">${esc(label)}</text>`;
  }
  return svg;
}

function note(t, { x, y, w, h, tone, title, items }) {
  const c = t[tone];
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${t.card}" stroke="${t.line}"/>`,
    `<circle cx="${x + 20}" cy="${y + 24}" r="5" fill="${c.ink}"/>`,
    `<text x="${x + 33}" y="${y + 29}" font-family="${SANS}" font-size="14" font-weight="600" fill="${t.text}">${esc(title)}</text>`,
    ...items.map(
      (s, i) =>
        `<text x="${x + 20}" y="${y + 54 + i * 21}" font-family="${SANS}" font-size="13" fill="${t.muted}">${esc(s)}</text>`,
    ),
  ].join("\n");
}

function svg(t, w, h, title, body) {
  const heads = [...new Set([t.edge, t.blue.ink, t.green.ink, t.red.ink])]
    .map(
      (c) =>
        `<marker id="head-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>${heads}</defs>
<rect width="${w}" height="${h}" rx="14" fill="${t.bg}"/>
<text x="40" y="48" font-family="${SANS}" font-size="20" font-weight="700" fill="${t.text}">${esc(title)}</text>
${body}
</svg>`;
}

const DIAGRAMS = {
  "what-it-does": (t) => {
    const w = 184;
    const y = 100;
    const h = 112;
    const xs = [40, 274, 508, 742, 976];
    const mid = y + h / 2;
    const steps = [
      { tone: "blue", title: "create()", mono: true, sub: ["a new operation ID", "and idempotency key"], chip: "kept for every retry" },
      { tone: "blue", title: "run()", mono: true, sub: ["saves the record,", "then sends the request"], chip: "Idempotency-Key header" },
      { tone: "gray", title: "Your backend", sub: ["creates the order", "and stores the key"] },
      { tone: "amber", title: "uncertain", mono: true, sub: ["the response was lost,", "so it isn't failed"], chip: "never resent on its own" },
      { tone: "green", title: "reconcile()", mono: true, sub: ["asks your backend", "`GET /orders/by-key/…`"], chip: "found it: one order" },
    ];
    return svg(
      t,
      1200,
      480,
      "What Orynth does when a response is lost",
      [
        ...steps.map((s, i) => box(t, { x: xs[i], y, w, h, step: i + 1, ...s })),
        arrow(t, [
          [xs[0] + w, mid],
          [xs[1] - 2, mid],
        ]),
        arrow(
          t,
          [
            [xs[1] + w, mid],
            [xs[2] - 2, mid],
          ],
          { label: "POST", at: [xs[1] + w + 25, mid - 17] },
        ),
        arrow(
          t,
          [
            [xs[2] + w, mid],
            [xs[3] - 2, mid],
          ],
          { label: "lost", at: [xs[2] + w + 25, mid - 17], dashed: true, color: t.red.ink },
        ),
        arrow(t, [
          [xs[3] + w, mid],
          [xs[4] - 2, mid],
        ]),
        box(t, {
          x: xs[3],
          y: 296,
          w,
          h: 96,
          tone: "gray",
          title: "Tab closed?",
          sub: ["restore() on the next start:", "same ID, same key"],
        }),
        arrow(
          t,
          [
            [xs[3] + w / 2, y + h],
            [xs[3] + w / 2, 294],
          ],
          { label: "reload", at: [xs[3] + w / 2, 254], dashed: true },
        ),
        arrow(
          t,
          [
            [xs[3] + w, 344],
            [xs[4] + w / 2, 344],
            [xs[4] + w / 2, y + h + 2],
          ],
          { label: "then", at: [xs[4] + w / 2, 290] },
        ),
        note(t, {
          x: 40,
          y: 296,
          w: 330,
          h: 124,
          tone: "red",
          title: "Without it",
          items: [
            "A lost response looks like a failure. The user",
            "orders again, or a retry without a key creates",
            "a second order.",
          ],
        }),
        note(t, {
          x: 390,
          y: 296,
          w: 330,
          h: 124,
          tone: "green",
          title: "With it",
          items: [
            "Every attempt carries the same key, and an",
            "unknown outcome is checked with your backend",
            "before anything is sent again: one order.",
          ],
        }),
        `<text x="40" y="452" font-family="${SANS}" font-size="13" fill="${t.muted}">It never resends after the key expired, the input changed or the user signed out, or while another tab is sending it.</text>`,
      ].join("\n"),
    );
  },

  lifecycle: (t) => {
    const w = 180;
    const h = 96;
    // Columns: created, pending, the outcomes, recovering. Rows: succeeded, uncertain, failed.
    const col = { created: 40, pending: 300, outcome: 600, recovering: 940 };
    const row = { top: 66, mid: 202, bottom: 338 };
    const pc = col.pending + w / 2;
    const rc = col.recovering + w / 2;
    const left = col.outcome - 2;
    const right = col.outcome + w;
    return svg(
      t,
      1200,
      500,
      "How an operation moves",
      [
        box(t, { x: col.created, y: row.mid, w, h, tone: "gray", title: "created", mono: true, sub: ["create(): a new ID", "and key"] }),
        box(t, { x: col.pending, y: row.mid, w, h, tone: "blue", title: "pending", mono: true, sub: ["record saved,", "request in flight"] }),
        box(t, { x: col.outcome, y: row.top, w, h, tone: "green", title: "succeeded", mono: true, sub: ["result stored,", "record deleted"] }),
        box(t, {
          x: col.outcome,
          y: row.mid,
          w,
          h,
          tone: "amber",
          title: "uncertain",
          mono: true,
          sub: ["network error, timeout,", "408, 409 or 5xx"],
        }),
        box(t, {
          x: col.outcome,
          y: row.bottom,
          w,
          h,
          tone: "red",
          title: "failed",
          mono: true,
          sub: ["other 4xx, connection", "refused"],
        }),
        box(t, {
          x: col.recovering,
          y: row.mid,
          w,
          h,
          tone: "blue",
          title: "recovering",
          mono: true,
          sub: ["reconcile() asks", "your backend"],
        }),
        arrow(
          t,
          [
            [col.created + w, 250],
            [col.pending - 2, 250],
          ],
          { label: "run()", at: [(col.created + w + col.pending) / 2, 233] },
        ),
        arrow(
          t,
          [
            [pc, row.mid],
            [pc, 114],
            [left, 114],
          ],
          { label: "response", at: [(pc + left) / 2, 114], color: t.green.ink },
        ),
        arrow(t, [
          [col.pending + w, 238],
          [left, 238],
        ]),
        arrow(
          t,
          [
            [left, 266],
            [col.pending + w + 2, 266],
          ],
          { label: "retry()", at: [(col.pending + w + left) / 2, 284], color: t.blue.ink },
        ),
        arrow(
          t,
          [
            [pc + 20, row.mid + h],
            [pc + 20, 370],
            [left, 370],
          ],
          { label: "definitive error", at: [(pc + 20 + left) / 2, 370] },
        ),
        arrow(
          t,
          [
            [left + 2, 410],
            [pc - 20, 410],
            [pc - 20, row.mid + h + 2],
          ],
          { label: "retry()", at: [(pc - 20 + left) / 2, 410], color: t.blue.ink },
        ),
        arrow(
          t,
          [
            [right, 238],
            [col.recovering - 2, 238],
          ],
          { label: "reconcile()", at: [(right + col.recovering) / 2, 221] },
        ),
        arrow(
          t,
          [
            [col.recovering, 266],
            [right + 2, 266],
          ],
          { label: "still unknown", at: [(right + col.recovering) / 2, 284] },
        ),
        arrow(
          t,
          [
            [rc, row.mid],
            [rc, 114],
            [right + 2, 114],
          ],
          { label: "completed", at: [(rc + right) / 2, 114], color: t.green.ink },
        ),
        arrow(
          t,
          [
            [rc, row.mid + h],
            [rc, 370],
            [right + 2, 370],
          ],
          { label: "did not complete", at: [(rc + right) / 2, 370] },
        ),
        `<text x="40" y="470" font-family="${SANS}" font-size="13" fill="${t.muted}">An uncertain operation stays uncertain until a request succeeds or reconcile() settles it. Restored operations start as uncertain.</text>`,
      ].join("\n"),
    );
  },
};

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const [name, draw] of Object.entries(DIAGRAMS)) {
  for (const [theme, t] of Object.entries(THEMES)) {
    const source = draw(t);
    await page.setContent(`<html><body style="margin:0;background:transparent">${source}</body></html>`);
    const file = path.join(out, `${name}-${theme}.png`);
    await page.locator("svg").screenshot({ path: file, omitBackground: true });
    console.log(path.relative(process.cwd(), file));
  }
}
await browser.close();
