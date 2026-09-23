import {
  AIProvider,
  AIProviderError,
  CompleteOptions,
  CompleteResult,
  StructuredRequest,
} from "../provider";

/**
 * Deterministic mock provider (ADR D-03: a mock provider for local development
 * and tests so nothing blocks on API keys).
 *
 * Produces schema-valid fixtures from the descriptor in `user` text, so the
 * full pipeline runs offline with identical code paths. Deterministic: the same
 * descriptor always yields the same attributes.
 *
 * Test markers (never present in real data):
 *   "@@invalid" → emit JSON that fails schema validation (exercises fail-safe)
 *   "@@throw"   → throw a network error (exercises retry + error category)
 *
 * The image is intentionally IGNORED: a mock cannot see pixels; visual fields
 * are derived heuristically from the descriptor.
 */

const HASH_SEED = 7;
const HASH_MOD = 9973;

function hashOf(s: string): number {
  return [...s].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % HASH_MOD, HASH_SEED);
}

const SUBCATEGORY_POOL: Record<string, string[]> = {
  tops: ["crewneck t-shirt", "button-up shirt", "long-sleeve top", "tank top", "blouse"],
  bottoms: ["straight-leg trousers", "wide-leg trousers", "distressed jeans", "midi skirt", "tailored shorts"],
  dresses: ["slip dress", "shirt dress", "wrap dress", "maxi dress"],
  outerwear: ["overshirt", "blazer", "field jacket", "chore coat", "knit cardigan"],
  shoes: ["low-top sneaker", "leather loafer", "ankle boot", "slip-on"],
  bags: ["leather tote", "crossbody bag", "belt bag", "canvas backpack"],
  accessories: ["knit beanie", "scarf", "leather belt", "sunglasses"],
  others: ["everyday carry piece", "statement piece"],
};

const STYLE_POOL = ["minimalist", "classic", "casual", "city", "preppy", "lounge", "sporty", "vintage"];

export const MOCK_CONTRACT_VERSION = "mock-v1";

export const mockProvider: AIProvider = {
  name: "mock",
  contractVersion: MOCK_CONTRACT_VERSION,

  async complete(req: StructuredRequest, opts: CompleteOptions = {}): Promise<CompleteResult> {
    const started = Date.now();
    const user = req.user || "";

    // Deterministic pseudo-latency so timings are visible but tests stay fast.
    await new Promise((r) => setTimeout(r, 5));

    if (user.includes("@@throw")) {
      throw new AIProviderError("network", "mock provider forced network failure");
    }

    // Query-understanding contract (Phase 3): a deterministic, always-valid
    // OutfitQuery so the recommendation workflow runs fully offline with the
    // real code paths. Recognised by a signature token in the system prompt —
    // never sent in normal clothing-attributes calls. Its own malformed marker
    // (#@qbad) exercises the query validation fail-safe without touching the
    // clothing-metadata @@invalid contract.
    if ((req.system ?? "").includes("OUTFIT_QUERY_SCHEMA")) {
      if (user.includes("@@qbad")) {
        return {
          text: '{"hard": "nope", "soft": 42, "context": "broken"}',
          meta: { provider: "mock", model: "mock-outfit-query-v1", version: MOCK_CONTRACT_VERSION, latencyMs: Date.now() - started, usage: { promptTokens: 12, completionTokens: 6 } },
        };
      }
      return {
        text: JSON.stringify(buildMockOutfitQuery(user)),
        meta: { provider: "mock", model: opts.model ?? "mock-outfit-query-v1", version: MOCK_CONTRACT_VERSION, latencyMs: Date.now() - started, usage: { promptTokens: 22 + (hashOf(user) % 40), completionTokens: 12 + (hashOf(user) % 24) } },
      };
    }

    // Outfit-validation contract (Phase 4): a deterministic, always-valid
    // verdict for the semantic-review lane. Recognised by its system-prompt
    // signature token. Markers only meaningful here (#@vbad → malformed JSON,
    // #@vstyle → a coherent-but-failing verdict that exercises the FAIL path).
    if ((req.system ?? "").includes("OUTFIT_VALIDATION_SCHEMA")) {
      if (user.includes("@@vbad")) {
        return {
          text: '{"passed": "strange", "score": "eighty", "issues": 42, "checks": "nope"}',
          meta: { provider: "mock", model: "mock-outfit-validation-v1", version: MOCK_CONTRACT_VERSION, latencyMs: Date.now() - started, usage: { promptTokens: 10, completionTokens: 5 } },
        };
      }
      if (user.includes("@@vstyle")) {
        return {
          text: JSON.stringify({
            passed: false,
            score: 40,
            issues: ["colour clash between the top and the trousers"],
            checks: {
              styleCoherence: { passed: false, note: "tone mismatch" },
              colorHarmony: { passed: false, note: "clashing hues" },
              occasionAppropriateness: { passed: true, note: "fits the occasion" },
              silhouetteCompatibility: { passed: true, note: "balanced proportions" },
            },
          }),
          meta: { provider: "mock", model: "mock-outfit-validation-v1", version: MOCK_CONTRACT_VERSION, latencyMs: Date.now() - started, usage: { promptTokens: 14 + (hashOf(user) % 18), completionTokens: 7 + (hashOf(user) % 10) } },
        };
      }
      return {
        text: JSON.stringify(buildMockValidation(user)),
        meta: { provider: "mock", model: opts.model ?? "mock-outfit-validation-v1", version: MOCK_CONTRACT_VERSION, latencyMs: Date.now() - started, usage: { promptTokens: 16 + (hashOf(user) % 22), completionTokens: 8 + (hashOf(user) % 12) } },
      };
    }

    if (user.includes("@@invalid")) {
      return {
        text: `{"colors": "definitely-not-an-array", "seasons": ["summer","winter"]}`,
        meta: { provider: "mock", model: opts.model ?? "mock-clothing-v1", version: MOCK_CONTRACT_VERSION, latencyMs: Date.now() - started, usage: { promptTokens: 10, completionTokens: 5 } },
      };
    }

    const category = (user.match(/Category:\s*(\w+)/)?.[1] ?? "tops") as keyof typeof SUBCATEGORY_POOL;
    const pool = SUBCATEGORY_POOL[category] ?? SUBCATEGORY_POOL.others;
    const h = hashOf(user);

    const text = JSON.stringify({
      subcategory: pool[h % pool.length],
      colors: [{ name: "grey" }, { name: "white" }],
      material: ["cotton"],
      pattern: ["solid"],
      fit: "regular",
      styleTags: [STYLE_POOL[h % STYLE_POOL.length], STYLE_POOL[(h >> 2) % STYLE_POOL.length]],
      seasons: ["spring", "autumn"],
      occasions: ["casual", "weekend"],
      formality: "casual",
      weatherSuitability: ["mild"],
    });

    return {
      text,
      meta: { provider: "mock", model: opts.model ?? "mock-clothing-v1", version: MOCK_CONTRACT_VERSION, latencyMs: Date.now() - started, usage: { promptTokens: 18 + (h % 20), completionTokens: 8 + (h % 12) } },
    };
  },
};

/**
 * Deterministic OutfitQuery fixture for the query-understanding contract.
 * Deliberately simple keyword matching — the MOCK is a test double, not the
 * bilingual extractor (that lives in src/lib/recommend/deterministic.ts).
 * Output is always a structurally valid OutfitQuery: never contains item IDs
 * or clothing names (hard+soft+context only).
 */
function buildMockOutfitQuery(user: string): Record<string, unknown> {
  const low = user.toLowerCase();
  const contains = (terms: string[]) => terms.some((t) => low.includes(t));

  const categories: string[] = [];
  if (contains(["top", "tops", "shirt", "tee", "blouse", "turtleneck", "上衣", "衬衫", "t恤", "毛衣"])) categories.push("tops");
  if (contains(["bottom", "bottoms", "jeans", "trouser", "pants", "裤子", "牛仔裤", "长裤", "半身裙"])) categories.push("bottoms");
  if (contains(["dress", "gown", "连衣裙", "裙子"])) categories.push("dresses");
  if (contains(["coat", "jacket", "outerwear", "trench", "外套", "大衣", "夹克", "开衫"])) categories.push("outerwear");
  if (contains(["shoe", "shoes", "sneaker", "boot", "loafer", "鞋", "运动鞋", "靴子"])) categories.push("shoes");
  if (contains(["bag", "tote", "backpack", "包", "手提包"])) categories.push("bags");
  if (contains(["accessor", "scarf", "hat", "belt", "手套", "围巾", "帽子", "配饰"])) categories.push("accessories");

  const colors: string[] = [];
  const COLOR_TERMS: Array<[string, string[]]> = [
    ["white", ["white", "白色", "白"]],
    ["black", ["black", "黑色", "黑"]],
    ["blue", ["blue", "蓝色", "蓝"]],
    ["grey", ["grey", "gray", "灰色", "灰"]],
    ["beige", ["beige", "米白", "米色"]],
    ["cream", ["cream", "奶油色"]],
    ["brown", ["brown", "棕色", "咖啡色"]],
    ["olive", ["olive", "橄榄绿"]],
  ];
  for (const [name, terms] of COLOR_TERMS) if (contains(terms) && !colors.includes(name)) colors.push(name);

  const seasons: string[] = [];
  const SEASON_TERMS: Array<[string, string[]]> = [
    ["spring", ["spring", "春季", "春天", "春"]],
    ["summer", ["summer", "夏季", "夏天", "夏"]],
    ["autumn", ["autumn", "fall", "秋季", "秋天", "秋"]],
    ["winter", ["winter", "冬季", "冬天", "冬"]],
  ];
  for (const [name, terms] of SEASON_TERMS) if (contains(terms) && !seasons.includes(name)) seasons.push(name);

  let formality: string | null = null;
  const FORMALITY_PRIORITY: Array<[string, string[]]> = [
    ["business-formal", ["business formal", "商务正式"]],
    ["smart-casual", ["smart casual", "smart-casual", "半正式", "休闲商务"]],
    ["business", ["business", "office", "work", "商务", "通勤"]],
    ["formal", ["formal", "gala", "正式", "晚宴"]],
    ["casual", ["casual", "休闲", "随性"]],
  ];
  for (const [name, terms] of FORMALITY_PRIORITY) {
    if (contains(terms)) {
      formality = name;
      break;
    }
  }

  const hard: Record<string, unknown> = {};
  if (categories.length) hard.categories = [...new Set(categories)];
  if (colors.length) hard.colors = [...new Set(colors)];
  if (seasons.length) hard.seasons = [...new Set(seasons)];
  if (formality) hard.formality = formality;

  return {
    hard,
    soft: ["matching the vibe", "for the occasion"],
    context: { occasion: "daily" },
  };
}

/**
 * Deterministic, always-passing validation verdict for the semantic lane.
 * The MOCK is a test double — real aesthetics are the reviewer's business.
 * Score always ≥ 60 so `passed` and the threshold agree by construction.
 */
function buildMockValidation(user: string): Record<string, unknown> {
  const score = 82 + (hashOf(user) % 15); // 82..96
  return {
    passed: true,
    score,
    issues: [],
    checks: {
      styleCoherence: { passed: true, note: "cohesive capsule" },
      colorHarmony: { passed: true, note: "complementary tones" },
      occasionAppropriateness: { passed: true, note: "fits the occasion" },
      silhouetteCompatibility: { passed: true, note: "balanced proportions" },
    },
  };
}