// Layer 1 (spec §3.5): analyzer unit tests via _analyze — exact token
// expectations for the specs.md §5 forms plus real catalog artifacts (A1).
import { describe, expect, it } from "vitest";

import { analyzeTokens } from "./harness";

const morph = (text: string) => analyzeTokens("hebrew_morph", text);
const bare = (text: string) => analyzeTokens("hebrew_text", text);

describe("hebrew_morph: §5 morphology forms", () => {
  it("folds plural to the singular stem: שמנים → שמנ", async () => {
    expect(await morph("שמנים")).toContain("שמנ");
  });

  it("strips a clitic non-destructively: למראה emits original + מראה + ראה", async () => {
    const tokens = await morph("למראה");
    expect(tokens).toContain("למראה");
    expect(tokens).toContain("מראה");
    expect(tokens).toContain("ראה");
  });

  it("never destroys an ambiguous original: מראה still emits מראה", async () => {
    expect(await morph("מראה")).toContain("מראה");
  });

  it("strips single clitics: בשמן and השמן reach stem שמנ", async () => {
    expect(await morph("בשמן")).toContain("שמנ");
    expect(await morph("השמן")).toContain("שמנ");
  });

  it("combines prefix strip + plural fold: ושקדים → שקד", async () => {
    expect(await morph("ושקדים")).toContain("שקד");
  });

  it("strips stacked clitics via the double-prefix chain: ולמראה → מראה", async () => {
    expect(await morph("ולמראה")).toContain("מראה");
  });

  it("folds construct state: שמני גוף shares stem שמנ with שמן גוף", async () => {
    expect(await morph("שמני גוף")).toContain("שמנ");
    expect(await morph("שמן גוף")).toContain("שמנ");
  });

  it("does not strip feminine ה/ת (over-stemming guard): בית stays בית", async () => {
    expect(await morph("בית")).toEqual(["בית"]);
  });

  it("prefix guard: no strip when fewer than 3 letters would remain", async () => {
    expect(await morph("בגד")).toEqual(["בגד"]); // ב+גד blocked, גד too short
    expect(await morph("לגוף")).toContain("גופ"); // exactly 3 remain — strips
  });
});

describe("hebrew_morph: curated feminine singular↔plural pairs (he_fem_singular)", () => {
  // The corpus audit (scripts/nlp-audit.ts §C) showed feminine ־ה singulars
  // never meet their ־ות/־ימ plurals: the plural strips its suffix while the
  // singular keeps ה (general ה-stripping is a non-goal — over-stemming).
  // Retrieval-relevant noun pairs are bridged by a curated stemmer_override
  // mapping the singular onto the stem its plural already produces.
  const pairs: Array<[string, string, string]> = [
    ["אריזה", "אריזות", "אריז"], // packaging / refill
    ["מסכה", "מסכות", "מסכ"], // mask
    ["נסיעה", "נסיעות", "נסיע"], // travel (kits)
    ["לילה", "לילות", "ליל"], // night (cream)
    ["חומצה", "חומצות", "חומצ"], // acid (hyaluronic)
    ["פורמולה", "פורמולות", "פורמול"],
    ["שכבה", "שכבות", "שכב"], // layer
    ["מידה", "מידות", "מיד"], // size
  ];
  it.each(pairs)("%s and %s meet on stem %s", async (singular, plural, stem) => {
    expect(await morph(singular)).toContain(stem);
    expect(await morph(plural)).toContain(stem);
  });

  it("prefixed singular reaches the shared stem: באריזה → אריז", async () => {
    expect(await morph("באריזה")).toContain("אריז");
  });

  it("curated list does not leak into a general ה-strip: מראה gains no מרא variant", async () => {
    expect(await morph("מראה")).not.toContain("מרא");
  });
});

describe("tokenizer on real catalog artifacts (A1)", () => {
  it("anchor title: & dropped cleanly, Hebrew words tokenized with final letters folded", async () => {
    expect(await bare("שמן גוף & שימר שקדים למראה עור זוהר")).toEqual([
      "שמנ", "גופ", "שימר", "שקדימ", "למראה", "עור", "זוהר",
    ]);
  });

  it("geresh survives inside tokens: ג'ל and אייג'ינג stay whole", async () => {
    expect(await bare("ג'ל רחצה לבנדר")).toEqual(["ג'ל", "רחצה", "לבנדר"]);
    expect(await bare("אנטי אייג'ינג")).toEqual(["אנטי", "אייג'ינג"]);
  });

  it('gershayim + numbers with units: מ"ל stays one token, digits preserved', async () => {
    expect(await bare('קרם CC PORCELAINE 15 מ"ל + SPF 30')).toEqual([
      "קרמ", "cc", "porcelaine", "15", 'מ"ל', "spf", "30",
    ]);
  });

  it("Latin tokens stay intact for exact match: ESSENTIAL OILS unmangled on both analyzers", async () => {
    expect(await bare("ESSENTIAL OILS")).toEqual(["essential", "oils"]);
    expect(await morph("ESSENTIAL OILS")).toEqual(["essential", "oils"]);
  });
});
