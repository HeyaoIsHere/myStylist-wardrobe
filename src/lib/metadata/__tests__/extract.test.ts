import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AIProviderError, type AIProvider, type CompleteResult, type CompleteOptions, type StructuredRequest } from "../../ai/provider";
import { mockProvider } from "../../ai/providers/mock";
import { extractClothingMetadata } from "../service";
import { deleteMetadata, getMetadata } from "../store";
import { METADATA_SCHEMA_VERSION } from "../schema";

// Isolate all file I/O to a temp dir so the real repo data/ is never touched.
let tmp: string;
let metadataFile: string;
let logDir: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mystylist-metadata-test-"));
  metadataFile = path.join(tmp, "metadata.json");
  logDir = path.join(tmp, "logs");
  process.env.MYSTYLIST_METADATA_FILE = metadataFile;
  process.env.MYSTYLIST_LOG_DIR = logDir;
});

const INPUT = { itemId: "user-test1", name: "Blue Crew Neck Tee", category: "tops" as const };

/** Deterministic fake provider that can force failures per-call. */
function fakeProvider(respond: (n: number) => string, error?: (n: number) => void): AIProvider {
  let calls = 0;
  return {
    name: "fake",
    contractVersion: "fake-v1",
    async complete(req: StructuredRequest, opts: CompleteOptions = {}): Promise<CompleteResult> {
      const started = Date.now();
      calls += 1;
      if (error) error(calls);
      return {
        text: respond(calls),
        meta: { provider: "fake", model: opts.model ?? "fake-model-v1", version: "fake-v1", latencyMs: Date.now() - started },
      };
    },
  };
}

test("mock provider: successful extraction persists schema-valid metadata", async () => {
  const result = await extractClothingMetadata(INPUT, mockProvider);
  assert.equal(result.degraded, false);
  assert.ok(result.attrs, "attrs should be present on success");
  assert.ok(result.attrs.colors.length >= 1);
  assert.ok(result.attrs.seasons.length >= 1);
  assert.equal(result.system.validationResult, "ok");
  assert.equal(result.system.provider, "mock");
  assert.equal(result.system.version, METADATA_SCHEMA_VERSION);
  assert.ok(result.system.confidence > 0 && result.system.confidence <= 1);

  const record = getMetadata(INPUT.itemId);
  assert.ok(record);
  assert.deepStrictEqual(record.aiGenerated, result.attrs);
  // user-provided fields are authoritative and preserved verbatim
  assert.equal(record.userProvided.name, "Blue Crew Neck Tee");
  assert.equal(record.userProvided.category, "tops");
  // system metadata is separate from user-facing metadata
  assert.equal(record.system.model, "mock-clothing-v1");
  assert.equal(typeof record.system.requestId, "string");
});

test("structurally invalid model output degrades safely — never corrupts, still persists provenance", async () => {
  const id = "user-invalid";
  const provider = fakeProvider(() => `{"colors": "definitely-not-an-array", "seasons": [42]}`);
  const result = await extractClothingMetadata({ ...INPUT, itemId: id }, provider);

  assert.equal(result.degraded, true);
  assert.equal(result.attrs, null);
  assert.equal(result.system.validationResult, "invalid");
  assert.equal(result.system.errorCategory, null); // not a transport failure

  const record = getMetadata(id);
  assert.ok(record, "a degraded provenance record IS persisted (safe, no AI fields)");
  assert.equal(record.aiGenerated, null);
});

test("unparseable JSON is treated as invalid output", async () => {
  const id = "user-garbagejson";
  const provider = fakeProvider(() => "this is not json at all {");
  const result = await extractClothingMetadata({ ...INPUT, itemId: id }, provider);
  assert.equal(result.degraded, true);
  assert.equal(result.system.validationResult, "invalid");
});

test("all fields empty after canonicalization → threshold degrade", async () => {
  const id = "user-threshold";
  const provider = fakeProvider(() => JSON.stringify({ colors: [] }));
  const result = await extractClothingMetadata({ ...INPUT, itemId: id }, provider);
  assert.equal(result.degraded, true);
  assert.equal(result.system.validationResult, "threshold");
});

test("closed-domain drift is salvaged and marked coerced (not fatal)", async () => {
  const id = "user-coerced";
  const provider = fakeProvider(() =>
    JSON.stringify({
      subcategory: "  Tee ",
      colors: [{ name: "navy", hex: "#1a2b3c" }],
      seasons: ["summer", "sorrr"], // bogus season — must be dropped, not fatal
      weatherSuitability: ["cool", "HOT"],
      formality: "casual",
    }),
  );
  const result = await extractClothingMetadata({ ...INPUT, itemId: id }, provider);
  assert.equal(result.degraded, false);
  assert.equal(result.system.validationResult, "coerced");
  assert.deepEqual(result.attrs?.seasons, ["summer"]);
  assert.deepEqual(result.attrs?.weatherSuitability, ["cool", "hot"]);
  assert.equal(result.attrs?.formality, "casual");
  assert.equal(result.attrs?.subcategory, "tee");
});

test("transient provider failure retries once and still succeeds", async () => {
  const id = "user-retry";
  const provider = fakeProvider(
    () => JSON.stringify({ seasons: ["spring"], colors: [{ name: "white" }] }),
    (n: number) => {
      if (n === 1) throw new AIProviderError("network", "transient blip");
    },
  );
  const result = await extractClothingMetadata({ ...INPUT, itemId: id }, provider);
  assert.equal(result.degraded, false);
  assert.equal(result.system.attempts, 2);
});

test("persistent provider failure degrades with error category and attempt count", async () => {
  const id = "user-alwaysfail";
  const provider = fakeProvider(
    () => "",
    () => {
      throw new AIProviderError("timeout", "always times out");
    },
  );
  const result = await extractClothingMetadata({ ...INPUT, itemId: id }, provider);
  assert.equal(result.degraded, true);
  assert.equal(result.system.attempts, 2);
  assert.equal(result.system.validationResult, "none");
  assert.equal(result.system.errorCategory, "timeout");
});

test("config failures do not retry", async () => {
  const id = "user-config";
  const provider: AIProvider = {
    name: "fake",
    contractVersion: "fake-v1",
    async complete(): Promise<CompleteResult> {
      throw new AIProviderError("config", "no key configured");
    },
  };
  const result = await extractClothingMetadata({ ...INPUT, itemId: id }, provider);
  assert.equal(result.degraded, true);
  assert.equal(result.system.attempts, 1);
  assert.equal(result.system.errorCategory, "config");
});

test("observability log records the required fields and stays clean", async () => {
  const id = "user-telemetry";
  process.env.DEEPSEEK_API_KEY = "sk-super-secret-never-log";
  // image is deliberately NOT passed to the fake provider's log path here;
  // even when one is supplied, it never reaches telemetry.
  const provider = fakeProvider(() =>
    JSON.stringify({ colors: [{ name: "black" }], seasons: ["winter"], material: ["wool"] }),
  );
  await extractClothingMetadata({ ...INPUT, itemId: id, imageDataUrl: "data:image/png;base64,AAAA" }, provider);

  const logPath = path.join(logDir, "metadata.jsonl");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const entry = JSON.parse(lines[lines.length - 1]);

  assert.equal(entry.kind, "metadata_extraction");
  assert.equal(entry.clothingId, id);
  assert.equal(entry.provider, "fake");
  assert.ok(entry.requestId);
  assert.ok(entry.startTime);
  assert.ok(entry.durationMs >= 0);
  assert.equal(entry.success, true);
  assert.equal(entry.validationResult, "ok");
  assert.equal(entry.retryCount, 0);
  assert.equal(entry.errorCategory, null);

  // Sanitization: no keys, no images, no raw base64 content.
  const raw = fs.readFileSync(logPath, "utf8");
  assert.equal(raw.includes("sk-super-secret"), false, "API keys must never be logged");
  assert.equal(raw.includes("data:image"), false, "images must never be logged");
  assert.equal(raw.includes("AAAA"), false, "base64 payloads must never be logged");
});

test("deleteMetadata removes the record", async () => {
  const id = "user-delete";
  await extractClothingMetadata({ ...INPUT, itemId: id }, mockProvider);
  assert.ok(getMetadata(id));
  deleteMetadata(id);
  assert.equal(getMetadata(id), null);
});

test("metadata never touches the wardrobe store", () => {
  // The extraction writes only to MYSTYLIST_METADATA_FILE; the wardrobe store
  // path is untouched. Verify no stray files in the temp dir beyond metadata + logs.
  const entries = fs.readdirSync(tmp);
  assert.ok(!entries.includes("store.json"));
});