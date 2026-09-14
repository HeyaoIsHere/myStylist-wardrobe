/**
 * Generates editorial fashion-illustration SVG placeholders for every
 * wardrobe item and inspiration board (fallback when a real photo is
 * unavailable). Style: cream paper, thin ink strokes, muted garment fills.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WARDROBE_SLOTS, INSPO_SLOTS } from "./asset-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const W = 600, H = 800;
const INK = "#2A241E";
const PAPER = "#F5F0E7";

const COLORS = {
  white:     { fill: "#FBF9F4", shade: "#E3DDD2" },
  cream:     { fill: "#F0E7D8", shade: "#D8CBB2" },
  ivory:     { fill: "#F7F2E8", shade: "#E0D7C4" },
  oat:       { fill: "#E4D5BC", shade: "#C8B48E" },
  black:     { fill: "#2B2620", shade: "#4A443C", stroke: "#EFEAE0" },
  bluewhite: { fill: "#EAF0F4", shade: "#B9C8D4", stripe: "#8FA3B8" },
  indigo:    { fill: "#6A7C8F", shade: "#4A5B6C" },
  olive:     { fill: "#8B8A62", shade: "#6C6B48" },
  champagne: { fill: "#E9DCC3", shade: "#CBBDA0" },
  terracotta:{ fill: "#C08A6A", shade: "#9E6A4E" },
  grey:      { fill: "#A8A8A2", shade: "#86857F" },
  camel:     { fill: "#C8A97E", shade: "#A5855A" },
  beige:     { fill: "#D9C9AF", shade: "#B9A585" },
  nude:      { fill: "#E4CFC0", shade: "#C4A893" },
  brown:     { fill: "#8A6242", shade: "#6B4A30" },
  tan:       { fill: "#C9A26B", shade: "#A5824E" },
  straw:     { fill: "#E6D8AE", shade: "#C9B77F" },
  gold:      { fill: "#C9A227", shade: "#A38118" },
  pearl:     { fill: "#EFEAE0", shade: "#CFC7B5" },
  multi:     { fill: "#D9B8A5", shade: "#A5B8C9" },
  creamblack:{ fill: "#F0E7D8", shade: "#2B2620" },
};

// Deterministic pseudo-random for texture dots, seeded by stem
function rng(seed) {
  let s = 0;
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) % 9973;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const F = (x) => Math.round(x * 10) / 10;

function shadow() {
  return `<ellipse cx="300" cy="672" rx="128" ry="14" fill="#2A241E" opacity="0.07"/>`;
}

// ---------- Garment drawings (fill = garment color, shade = detail) ----------
function drawTop(v, c, stem) {
  const r = rng(stem);
  let body, extra = "";
  if (v === 0) {
    body = `<path d="M258,196 L342,196 L354,226 L366,430 L234,430 L246,226 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M262,196 L300,222 L338,196 L318,206 L300,214 L282,206 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="300" y1="222" x2="300" y2="430" stroke="${INK}" stroke-width="2.5"/>
      <path d="M258,210 L200,236 L186,296 L240,286 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M342,210 L400,236 L414,296 L360,286 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <line x1="186" y1="289" x2="240" y2="283" stroke="${c.shade}" stroke-width="2.5"/>
      <line x1="414" y1="289" x2="360" y2="283" stroke="${c.shade}" stroke-width="2.5"/>
      <rect x="256" y="272" width="36" height="34" fill="none" stroke="${c.shade}" stroke-width="2.5"/>
      <line x1="234" y1="430" x2="250" y2="446" stroke="${INK}" stroke-width="2.5"/>
      <line x1="366" y1="430" x2="350" y2="446" stroke="${INK}" stroke-width="2.5"/>`;
    extra = [255, 290, 325, 360, 395].map((y) => `<circle cx="300" cy="${y}" r="3.4" fill="${c.shade}" stroke="${INK}" stroke-width="1.5"/>`).join("");
  } else if (v === 1) {
    body = `<path d="M255,200 L345,200 L350,232 L362,330 L348,442 L252,442 L238,330 L250,232 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M276,200 L324,200 L318,210 L282,210 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M255,216 L186,248 L176,328 L242,314 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M345,216 L414,248 L424,328 L358,314 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M252,442 Q262,454 272,442 T292,442 T312,442 T332,442 T352,442" fill="none" stroke="${c.shade}" stroke-width="2.5"/>`;
    extra = [262, 300, 338].map((y) => `<circle cx="300" cy="${y}" r="3" fill="${c.shade}" stroke="${INK}" stroke-width="1.5"/>`).join("");
  } else {
    body = `<path d="M248,200 L352,200 L366,452 L234,452 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M272,200 Q300,228 328,200 Q300,244 272,200 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M248,214 L178,252 L170,346 L240,330 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M352,214 L422,252 L430,346 L360,330 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <rect x="234" y="440" width="132" height="22" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
      <rect x="170" y="334" width="70" height="18" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
      <rect x="360" y="334" width="70" height="18" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>`;
    extra = [250, 268, 286, 304, 322, 340, 358].map((x) => `<line x1="${x}" y1="444" x2="${x}" y2="458" stroke="${INK}" stroke-width="1.6" opacity="0.6"/>`).join("");
  }
  if (c.stripe) extra += `<g stroke="${c.stripe}" stroke-width="9" opacity="0.8">${[330, 362, 394].map((y) => `<line x1="238" y1="${y}" x2="362" y2="${y}"/>`).join("")}</g>`;
  return body + extra;
}

function drawBottom(v, c) {
  if (v === 3) {
    return `<rect x="250" y="176" width="100" height="22" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
      <path d="M252,198 L348,198 L392,600 L208,600 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <line x1="262" y1="198" x2="252" y2="600" stroke="${c.shade}" stroke-width="2" opacity="0.9"/>
      <line x1="282" y1="198" x2="276" y2="600" stroke="${c.shade}" stroke-width="2" opacity="0.9"/>
      <line x1="300" y1="198" x2="300" y2="600" stroke="${c.shade}" stroke-width="2" opacity="0.9"/>
      <line x1="318" y1="198" x2="324" y2="600" stroke="${c.shade}" stroke-width="2" opacity="0.9"/>
      <line x1="338" y1="198" x2="348" y2="600" stroke="${c.shade}" stroke-width="2" opacity="0.9"/>
      <path d="M208,600 Q300,616 392,600" fill="none" stroke="${INK}" stroke-width="2.5"/>`;
  }
  const wide = v === 1;
  const lOuter = wide ? 220 : 248, rOuter = wide ? 380 : 352;
  return `<rect x="242" y="178" width="116" height="26" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M246,204 L300,204 L300,${wide ? 640 : 616} L${lOuter},${wide ? 640 : 616} Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M300,204 L354,204 L${rOuter},${wide ? 640 : 616} L300,${wide ? 640 : 616} Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <line x1="300" y1="204" x2="300" y2="${wide ? 640 : 616}" stroke="${c.shade}" stroke-width="2"/>
    <line x1="${wide ? 260 : 273}" y1="248" x2="${wide ? 260 : 273}" y2="${wide ? 628 : 604}" stroke="${c.shade}" stroke-width="2" opacity="0.8"/>
    <line x1="${wide ? 340 : 327}" y1="248" x2="${wide ? 340 : 327}" y2="${wide ? 628 : 604}" stroke="${c.shade}" stroke-width="2" opacity="0.8"/>
    <path d="M246,238 Q258,252 270,240" fill="none" stroke="${c.shade}" stroke-width="2.5"/>
    <path d="M354,238 Q342,252 330,240" fill="none" stroke="${c.shade}" stroke-width="2.5"/>
    <rect x="258" y="178" width="8" height="26" fill="${c.fill}" stroke="${INK}" stroke-width="1.6"/>
    <rect x="334" y="178" width="8" height="26" fill="${c.fill}" stroke="${INK}" stroke-width="1.6"/>`;
}

function drawDress(v, c, stem) {
  const r = rng(stem);
  if (v === 0) {
    return `<line x1="272" y1="168" x2="272" y2="210" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
      <line x1="328" y1="168" x2="328" y2="210" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
      <path d="M264,210 L336,210 L340,330 L260,330 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M270,330 L330,330 L358,620 L242,620 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <line x1="300" y1="210" x2="300" y2="330" stroke="${c.shade}" stroke-width="2"/>
      <line x1="288" y1="330" x2="282" y2="620" stroke="${c.shade}" stroke-width="2" opacity="0.8"/>
      <line x1="312" y1="330" x2="318" y2="620" stroke="${c.shade}" stroke-width="2" opacity="0.8"/>`;
  }
  if (v === 1) {
    return `<line x1="278" y1="170" x2="280" y2="214" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
      <line x1="322" y1="170" x2="320" y2="214" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
      <path d="M262,214 L338,214 L344,330 L256,330 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M256,330 L344,330 L372,610 L228,610 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M278,214 L300,254 L322,214" fill="none" stroke="${INK}" stroke-width="2.5"/>
      <line x1="300" y1="254" x2="300" y2="610" stroke="${c.shade}" stroke-width="2" opacity="0.7"/>
      <line x1="256" y1="330" x2="344" y2="610" stroke="${c.shade}" stroke-width="1.6" opacity="0.6"/>`;
  }
  return `<path d="M276,200 L324,200 L320,212 L280,212 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M262,212 L338,212 L356,520 L244,520 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M262,226 L196,254 L188,346 L252,332 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M338,226 L404,254 L412,346 L348,332 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <rect x="244" y="508" width="112" height="20" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <rect x="188" y="334" width="64" height="17" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <rect x="348" y="334" width="64" height="17" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    ${[262, 280, 298, 316, 334].map((x) => `<line x1="${x}" y1="232" x2="${x}" y2="506" stroke="${c.shade}" stroke-width="1.6" opacity="0.55"/>`).join("")}
    <circle cx="${300 + (r() - 0.5) * 40}" cy="${220 + r() * 60}" r="2" fill="${c.shade}" opacity="0.8"/>`;
}

function drawCoat(v, c) {
  const trench = v === 1;
  return `<path d="M250,190 L350,190 L368,300 L372,620 L228,620 L232,300 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M262,190 L300,246 L338,190 L318,216 L300,232 L282,216 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M250,206 L178,242 L168,334 L238,318 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M350,206 L422,242 L432,334 L362,318 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <rect x="232" y="436" width="136" height="24" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <circle cx="368" cy="448" r="7" fill="none" stroke="${INK}" stroke-width="2.5"/>
    <path d="M368,452 L390,478 L382,492 L362,468 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
    ${trench ? `<line x1="232" y1="306" x2="262" y2="368" stroke="${c.shade}" stroke-width="2.5"/>
      <line x1="368" y1="306" x2="338" y2="368" stroke="${c.shade}" stroke-width="2.5"/>
      <rect x="246" y="190" width="16" height="26" fill="${c.shade}" stroke="${INK}" stroke-width="2"/>
      <rect x="338" y="190" width="16" height="26" fill="${c.shade}" stroke="${INK}" stroke-width="2"/>` : ""}
    <circle cx="316" cy="272" r="3.4" fill="${c.shade}" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="284" cy="272" r="3.4" fill="${c.shade}" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="316" cy="312" r="3.4" fill="${c.shade}" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="284" cy="312" r="3.4" fill="${c.shade}" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="316" cy="352" r="3.4" fill="${c.shade}" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="284" cy="352" r="3.4" fill="${c.shade}" stroke="${INK}" stroke-width="1.5"/>
    <path d="M238,396 L268,388" stroke="${c.shade}" stroke-width="2.5"/>
    <path d="M362,396 L332,388" stroke="${c.shade}" stroke-width="2.5"/>
    <line x1="168" y1="327" x2="238" y2="314" stroke="${c.shade}" stroke-width="2.5"/>
    <line x1="432" y1="327" x2="362" y2="314" stroke="${c.shade}" stroke-width="2.5"/>`;
}

function drawJacket(v, c, stem) {
  const r = rng(stem);
  if (v === 0) {
    return `<path d="M252,196 L348,196 L358,330 L348,470 L252,470 L242,330 Z" fill="${c.fill}" stroke="${c.stroke || INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M260,196 L340,196 L334,210 L266,210 Z" fill="${c.shade}" stroke="${c.stroke || INK}" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M252,212 L188,240 L180,320 L242,306 Z" fill="${c.fill}" stroke="${c.stroke || INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M348,212 L412,240 L420,320 L358,306 Z" fill="${c.fill}" stroke="${c.stroke || INK}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M284,202 L290,330 L300,470" fill="none" stroke="${c.stroke || INK}" stroke-width="2.5"/>
      ${[290, 310, 330, 350, 370, 390, 410, 430, 450].map((y, i) => `<line x1="${286 - (i % 2) * 2}" y1="${y}" x2="${292 - (i % 2) * 2}" y2="${y + 10}" stroke="${c.stroke || INK}" stroke-width="2" opacity="0.85"/>`).join("")}
      <path d="M252,414 L282,404" stroke="${c.stroke || INK}" stroke-width="2.5"/>
      <path d="M318,394 L348,384" stroke="${c.stroke || INK}" stroke-width="2.5"/>
      <path d="M300,424 L332,416" stroke="${c.stroke || INK}" stroke-width="2.5"/>
      <path d="M252,470 L254,480 M300,470 L300,480 M348,470 L346,480" stroke="${c.stroke || INK}" stroke-width="2"/>
      <circle cx="236" cy="330" r="3" fill="${c.stroke || INK}"/>
      <circle cx="364" cy="330" r="3" fill="${c.stroke || INK}"/>`;
  }
  return `<path d="M276,198 Q300,216 324,198" fill="none" stroke="${INK}" stroke-width="3"/>
    <path d="M254,198 L346,198 L352,460 L248,460 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M254,214 L190,244 L182,326 L244,312 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M346,214 L410,244 L418,326 L356,312 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <rect x="262" y="330" width="34" height="36" rx="3" fill="none" stroke="${c.shade}" stroke-width="2.5"/>
    <rect x="304" y="330" width="34" height="36" rx="3" fill="none" stroke="${c.shade}" stroke-width="2.5"/>
    <circle cx="279" cy="366" r="3" fill="${c.shade}"/><circle cx="321" cy="366" r="3" fill="${c.shade}"/>
    ${Array.from({ length: 14 }, () => `<line x1="${248 + r() * 104}" y1="462" x2="${248 + r() * 104 + 4}" y2="480" stroke="${c.shade}" stroke-width="2"/>`).join("")}
    ${Array.from({ length: 26 }, () => `<circle cx="${252 + r() * 98}" cy="${216 + r() * 220}" r="${1 + r() * 2}" fill="${c.shade}" opacity="0.3"/>`).join("")}`;
}

function drawSneaker(c) {
  return `<path d="M120,560 L460,560 L456,596 L128,596 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M140,560 Q142,490 190,472 L270,452 L300,470 L360,452 L430,470 Q470,490 462,560 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M140,560 Q180,536 214,526 L214,560 Z" fill="${c.shade}" opacity="0.55" stroke="${INK}" stroke-width="2"/>
    <line x1="270" y1="455" x2="300" y2="495" stroke="${c.shade}" stroke-width="3"/>
    <line x1="290" y1="453" x2="320" y2="493" stroke="${c.shade}" stroke-width="3"/>
    <line x1="310" y1="452" x2="340" y2="490" stroke="${c.shade}" stroke-width="3"/>
    <line x1="330" y1="452" x2="360" y2="486" stroke="${c.shade}" stroke-width="3"/>
    <circle cx="273" cy="458" r="4" fill="none" stroke="${INK}" stroke-width="2"/>
    <circle cx="293" cy="456" r="4" fill="none" stroke="${INK}" stroke-width="2"/>
    <circle cx="313" cy="455" r="4" fill="none" stroke="${INK}" stroke-width="2"/>
    <circle cx="333" cy="455" r="4" fill="none" stroke="${INK}" stroke-width="2"/>
    <rect x="438" y="448" width="24" height="26" rx="3" fill="${c.fill}" stroke="${INK}" stroke-width="2.5"/>
    <line x1="124" y1="576" x2="456" y2="576" stroke="${INK}" stroke-width="2" opacity="0.5"/>
    <path d="M210,470 Q222,458 236,458" fill="none" stroke="${INK}" stroke-width="2" opacity="0.6"/>`;
}

function drawLoafer(c) {
  return `<path d="M140,560 L440,560 L434,588 L150,588 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M150,560 L420,560 L410,510 Q408,490 396,484 L340,470 L300,496 L250,472 L206,484 Q192,490 190,512 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M250,500 L340,500 L338,530 L252,530 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M288,502 L294,514 L300,502 L306,514 L312,502" fill="none" stroke="${c.fill}" stroke-width="2"/>
    <line x1="150" y1="572" x2="434" y2="572" stroke="${INK}" stroke-width="1.6" opacity="0.5"/>`;
}

function drawHeel(c) {
  return `<path d="M150,560 L420,560 L416,568 L154,568 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M320,568 L336,568 L330,650 L326,650 Z" fill="${c.fill}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M150,560 L300,560 L322,502 Q326,478 304,478 L226,478 L196,502 Q172,522 150,560 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M150,560 Q160,536 182,520" fill="none" stroke="${c.shade}" stroke-width="2"/>
    <path d="M228,520 L238,474 L304,474" fill="none" stroke="${c.shade}" stroke-width="4" stroke-linecap="round"/>
    <path d="M240,520 Q188,540 178,560" fill="none" stroke="${c.shade}" stroke-width="3"/>`;
}

function drawBoot(c) {
  return `<path d="M140,560 L460,560 L454,588 L150,588 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M196,340 L424,340 L434,560 L166,560 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M166,560 Q202,530 232,520" fill="none" stroke="${c.shade}" stroke-width="2"/>
    <path d="M212,362 L244,560" stroke="${c.shade}" stroke-width="3" stroke-dasharray="10 6"/>
    <path d="M388,362 L356,560" stroke="${c.shade}" stroke-width="3" stroke-dasharray="10 6"/>
    <path d="M296,340 L324,340 L318,320 L302,320 Z" fill="${c.fill}" stroke="${INK}" stroke-width="2.5"/>`;
}

function drawFlat(c) {
  return `<path d="M150,560 L420,560 L416,572 L154,572 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M156,560 L400,560 L396,540 Q392,520 372,516 L300,500 L228,516 Q208,520 204,540 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M228,510 L206,492 L210,524 Z" fill="${c.fill}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M228,510 L250,492 L246,524 Z" fill="${c.fill}" stroke="${INK}" stroke-width="2.5"/>
    <circle cx="228" cy="514" r="6" fill="none" stroke="${INK}" stroke-width="2.5"/>`;
}

function drawTote(v, c) {
  const weave = v === 1;
  return `<path d="M200,280 L400,280 L382,610 L218,610 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M260,280 C260,204 288,184 310,184 C332,184 360,204 360,280" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
    ${weave ? [320, 350, 380, 410, 440, 470, 500, 530, 560, 590].map((y) => `<line x1="${220 + (y % 2) * 0}" y1="${y}" x2="${380 - (y % 2) * 0}" y2="${y}" stroke="${c.shade}" stroke-width="2.4"/>`).join("") : `<line x1="300" y1="280" x2="300" y2="610" stroke="${c.shade}" stroke-width="1.8" stroke-dasharray="6 8"/>
      <line x1="224" y1="292" x2="230" y2="598" stroke="${c.shade}" stroke-width="1.8" stroke-dasharray="6 8"/>
      <line x1="376" y1="292" x2="370" y2="598" stroke="${c.shade}" stroke-width="1.8" stroke-dasharray="6 8"/>`}`;
}

function drawBag(c) {
  return `<path d="M244,304 C124,224 134,524 356,462" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>
    <path d="M240,300 L360,300 L360,470 Q360,480 350,480 L250,480 Q240,480 240,470 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M240,300 L360,300 L350,352 L250,352 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="300" cy="352" r="5.5" fill="none" stroke="${INK}" stroke-width="2.5"/>
    <path d="M300,358 L300,372" stroke="${INK}" stroke-width="2.5"/>
    <path d="M246,480 L246,494 M354,480 L354,494" stroke="${INK}" stroke-width="2" opacity="0.7"/>`;
}

function drawEarring(c) {
  return `<circle cx="255" cy="400" r="62" fill="none" stroke="${c.fill}" stroke-width="10"/>
    <path d="M255,338 C255,320 266,314 274,320" fill="none" stroke="${c.fill}" stroke-width="6" stroke-linecap="round"/>
    <circle cx="355" cy="414" r="48" fill="none" stroke="${c.fill}" stroke-width="9"/>
    <path d="M355,366 C355,352 363,347 369,352" fill="none" stroke="${c.fill}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="280" cy="372" r="4.5" fill="#FFFDF9" opacity="0.85"/>
    <circle cx="374" cy="392" r="3.5" fill="#FFFDF9" opacity="0.85"/>`;
}

function drawNecklace(c) {
  const pts = [];
  for (let i = 0; i < 15; i++) {
    const t = i / 14;
    const x = F((1 - t) ** 2 * 180 + 2 * (1 - t) * t * 300 + t ** 2 * 420);
    const y = F((1 - t) ** 2 * 420 + 2 * (1 - t) * t * 600 + t ** 2 * 420);
    pts.push(`<circle cx="${x}" cy="${y}" r="11" fill="${c.fill}" stroke="${c.shade}" stroke-width="2.5"/>`);
  }
  return pts.join("") + `<circle cx="181" cy="421" r="6" fill="${c.shade}"/>`;
}

function drawScarf(c) {
  return `<path d="M160,340 Q300,260 440,340 L440,400 Q300,320 160,400 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M160,420 Q300,340 440,420 L440,470 Q300,390 160,470 Z" fill="${c.shade}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <g stroke="${c.fill}" stroke-width="2.4">
      <circle cx="230" cy="445" r="4"/><circle cx="280" cy="438" r="4"/><circle cx="330" cy="442" r="4"/><circle cx="380" cy="448" r="4"/>
    </g>
    ${[175, 205, 235, 265, 295, 325, 355, 385, 415].map((x) => `<line x1="${x}" y1="470" x2="${x - 4}" y2="492" stroke="${c.shade}" stroke-width="2.6"/>`).join("")}
    ${[175, 205, 235, 265, 295, 325, 355, 385, 415].map((x) => `<line x1="${x}" y1="400" x2="${x - 3}" y2="418" stroke="${c.fill}" stroke-width="2.4"/>`).join("")}`;
}

function drawHat(v, c) {
  if (v === 0) {
    return `<ellipse cx="300" cy="480" rx="210" ry="52" fill="${c.fill}" stroke="${INK}" stroke-width="3"/>
      <path d="M212,468 C212,340 252,312 300,312 C348,312 388,340 388,468 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3"/>
      <ellipse cx="300" cy="470" rx="150" ry="34" fill="none" stroke="${c.shade}" stroke-width="2.4"/>
      <path d="M226,420 L374,420 L374,448 L226,448 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2.4"/>
      <path d="M300,428 L282,414 L284,442 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2"/>
      <path d="M300,428 L318,414 L316,442 Z" fill="${c.shade}" stroke="${INK}" stroke-width="2"/>
      <circle cx="300" cy="430" r="6.5" fill="none" stroke="${INK}" stroke-width="2.4"/>`;
  }
  return `<path d="M226,420 C226,330 264,296 300,296 C336,296 374,330 374,420 Z" fill="${c.fill}" stroke="${INK}" stroke-width="3"/>
    <path d="M226,420 L374,420 L374,458 Q300,474 226,458 Z" fill="${c.shade}" stroke="${INK}" stroke-width="3"/>
    ${[244, 258, 272, 286, 300, 314, 328, 342, 356].map((x) => `<line x1="${x}" y1="300" x2="${x}" y2="432" stroke="${c.shade}" stroke-width="2" opacity="0.55"/>`).join("")}
    <circle cx="300" cy="330" r="7" fill="none" stroke="${c.shade}" stroke-width="2" opacity="0.7"/>`;
}

function drawSock(v, c) {
  const y0 = v === 0 ? 220 : 200;
  const x0 = v === 0 ? 212 : 214;
  return `<rect x="${x0}" y="${y0}" width="64" height="34" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <rect x="${x0 + 112}" y="${y0}" width="64" height="34" fill="${c.shade}" stroke="${INK}" stroke-width="2.5"/>
    <path d="M${x0},${y0} L${x0 + 64},${y0} L${x0 + 64},${y0 + 214} Q${x0 + 64},${y0 + 248} ${x0 + 30},${y0 + 248} Q${x0},${y0 + 248} ${x0},${y0 + 214} Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M${x0 + 112},${y0} L${x0 + 176},${y0} L${x0 + 176},${y0 + 214} Q${x0 + 176},${y0 + 248} ${x0 + 142},${y0 + 248} Q${x0 + 112},${y0 + 248} ${x0 + 112},${y0 + 214} Z" fill="${c.fill}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <line x1="${x0}" y1="${y0 + 17}" x2="${x0 + 64}" y2="${y0 + 17}" stroke="${INK}" stroke-width="1.6" opacity="0.5"/>
    <line x1="${x0 + 112}" y1="${y0 + 17}" x2="${x0 + 176}" y2="${y0 + 17}" stroke="${INK}" stroke-width="1.6" opacity="0.5"/>`;
}

// ---------- Inspiration board abstractions ----------
function drawInspo(v, p) {
  const [a, b, c2] = p;
  const frame = `<rect x="26" y="26" width="548" height="748" fill="none" stroke="${INK}" stroke-width="1.6" opacity="0.2"/>
    <rect x="46" y="46" width="508" height="708" fill="none" stroke="${INK}" stroke-width="1" opacity="0.12"/>`;
  const caption = `<rect x="46" y="708" width="14" height="14" fill="${a}"/><line x1="70" y1="715" x2="150" y2="715" stroke="${INK}" stroke-width="1.6" opacity="0.4"/>`;
  const art = {
    0: `<circle cx="300" cy="380" r="150" fill="${a}" opacity="0.85"/><circle cx="300" cy="380" r="192" fill="none" stroke="${INK}" stroke-width="1.6" opacity="0.4"/><circle cx="452" cy="600" r="11" fill="${b}"/><line x1="90" y1="120" x2="510" y2="120" stroke="${INK}" stroke-width="1.4" opacity="0.3"/><line x1="90" y1="680" x2="510" y2="680" stroke="${INK}" stroke-width="1.4" opacity="0.3"/>`,
    1: `<rect x="140" y="180" width="60" height="520" fill="${a}" opacity="0.9"/><rect x="260" y="300" width="60" height="400" fill="${b}" opacity="0.9"/><rect x="380" y="120" width="60" height="580" fill="${c2}" opacity="0.85"/><circle cx="300" cy="90" r="16" fill="${a}"/>`,
    2: `<path d="M600,0 L600,260 A260,260 0 0 0 340,0 Z" fill="${a}" opacity="0.9"/><circle cx="180" cy="560" r="90" fill="${b}" opacity="0.8"/><line x1="60" y1="600" x2="540" y2="600" stroke="${INK}" stroke-width="1.4" opacity="0.3"/>`,
    3: `<polygon points="0,150 600,60 600,150 0,240" fill="${a}" opacity="0.9"/><polygon points="0,430 600,340 600,430 0,520" fill="${b}" opacity="0.85"/><rect x="430" y="580" width="90" height="90" fill="${c2}" opacity="0.9"/>`,
    4: `${[[130, 250], [250, 250], [370, 250], [130, 390], [250, 390], [370, 390], [130, 530], [250, 530], [370, 530]].map(([x, y], i) => `<rect x="${x}" y="${y}" width="100" height="100" fill="${i % 2 ? b : a}" opacity="${i % 2 ? 0.9 : 0.75}"/>`).join("")}<circle cx="470" cy="180" r="40" fill="${c2}" opacity="0.85"/>`,
    5: `<line x1="60" y1="300" x2="540" y2="300" stroke="${INK}" stroke-width="3" opacity="0.8"/>
      ${[150, 300, 450].map((x, i) => `<path d="M${x - 10},300 L${x + 10},300 L${x},344 Z" fill="none" stroke="${INK}" stroke-width="2.5"/><path d="M${x},344 Q${x - 40},300 ${x - 46},250" fill="none" stroke="${INK}" stroke-width="2.5"/><path d="M${x - 70},360 Q${x},320 ${x + 70},360 L${x + 56},580 L${x - 56},580 Z" fill="${[a, b, c2][i]}" opacity="0.9" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`).join("")}<line x1="60" y1="640" x2="540" y2="640" stroke="${INK}" stroke-width="1.4" opacity="0.3"/>`,
    6: `<circle cx="300" cy="290" r="72" fill="${a}" opacity="0.9"/><rect x="276" y="360" width="48" height="60" fill="${a}" opacity="0.9"/><path d="M140,640 Q300,370 460,640 Z" fill="${b}" opacity="0.85"/><circle cx="352" cy="290" r="7" fill="${c2}"/>`,
    7: `<text x="300" y="470" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="330" fill="${a}" opacity="0.9">S</text><line x1="210" y1="520" x2="390" y2="520" stroke="${INK}" stroke-width="2" opacity="0.5"/><circle cx="470" cy="120" r="5" fill="${b}"/>`,
    8: `<path d="M120,420 L290,420 L312,362 Q316,338 294,338 L216,338 L186,362 Q162,382 120,420 Z" fill="${a}" opacity="0.9" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/><path d="M290,428 L306,428 L300,510 L296,510 Z" fill="${a}" stroke="${INK}" stroke-width="2"/><rect x="330" y="300" width="150" height="180" rx="4" fill="${b}" opacity="0.9" stroke="${INK}" stroke-width="2.5"/><path d="M350,300 C350,240 380,224 400,224 C420,224 460,240 460,300" fill="none" stroke="${INK}" stroke-width="7"/><circle cx="300" cy="600" r="34" fill="${c2}" opacity="0.85"/>`,
    9: `<circle cx="240" cy="360" r="140" fill="${a}" opacity="0.5"/><circle cx="360" cy="360" r="140" fill="${b}" opacity="0.5"/><circle cx="300" cy="460" r="120" fill="${c2}" opacity="0.55"/><line x1="60" y1="140" x2="540" y2="140" stroke="${INK}" stroke-width="1.4" opacity="0.3"/>`,
    10: `<rect x="260" y="120" width="80" height="560" fill="${a}" opacity="0.9"/><circle cx="300" cy="120" r="44" fill="${b}"/><circle cx="300" cy="680" r="30" fill="${c2}"/><line x1="60" y1="60" x2="540" y2="60" stroke="${INK}" stroke-width="1.4" opacity="0.3"/>`,
    11: `<circle cx="440" cy="240" r="92" fill="${a}" opacity="0.9"/><line x1="60" y1="500" x2="540" y2="500" stroke="${INK}" stroke-width="2.4" opacity="0.7"/><path d="M60,500 Q200,400 340,500 Q440,560 540,500 L540,560 L60,560 Z" fill="${b}" opacity="0.8"/><rect x="100" y="600" width="16" height="70" fill="${c2}"/><rect x="140" y="620" width="16" height="50" fill="${c2}"/>`,
  }[v];
  return frame + art + caption;
}

// ---------- write ----------
const WARDROBE_DIR = join(ROOT, "public", "images", "wardrobe");
const INSPO_DIR = join(ROOT, "public", "images", "inspo");
mkdirSync(WARDROBE_DIR, { recursive: true });
mkdirSync(INSPO_DIR, { recursive: true });

for (const slot of WARDROBE_SLOTS) {
  const c = COLORS[slot.color] || COLORS.cream;
  const garment = {
    top: () => drawTop(slot.variant, c, slot.stem),
    bottom: () => drawBottom(slot.variant, c),
    dress: () => drawDress(slot.variant, c, slot.stem),
    coat: () => drawCoat(slot.variant, c),
    jacket: () => drawJacket(slot.variant, c, slot.stem),
    sneaker: () => drawSneaker(c),
    loafer: () => drawLoafer(c),
    heel: () => drawHeel(c),
    boot: () => drawBoot(c),
    flat: () => drawFlat(c),
    tote: () => drawTote(slot.variant, c),
    bag: () => drawBag(c),
    earring: () => drawEarring(c),
    necklace: () => drawNecklace(c),
    scarf: () => drawScarf(c),
    hat: () => drawHat(slot.variant, c),
    sock: () => drawSock(slot.variant, c),
  }[slot.type]();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>
  ${garment}
  ${shadow()}
</svg>`;
  writeFileSync(join(WARDROBE_DIR, `${slot.stem}.svg`), svg);
}

for (const slot of INSPO_SLOTS) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>
  ${drawInspo(slot.variant, slot.palette)}
</svg>`;
  writeFileSync(join(INSPO_DIR, `${slot.stem}.svg`), svg);
}

console.log(`Generated ${WARDROBE_SLOTS.length} wardrobe + ${INSPO_SLOTS.length} inspo SVGs.`);
