# Part 1 Results — Hebrew Word-Pair Embedding Benchmark

Model: `gemini-embedding-001`, 3072 dims. Pairs: 66. Modes: symmetric (SEMANTIC_SIMILARITY both sides), retrieval (RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT).

## Category summary (cosine similarity)

| Category | Role | n | Mode | Mean | Median | Min | Max |
|---|---|---|---|---|---|---|---|
| plural_singular | gate | 10 | symmetric | 0.963 | 0.973 | 0.885 | 0.981 |
| plural_singular | gate | 10 | retrieval | 0.827 | 0.834 | 0.760 | 0.858 |
| prefix | gate | 8 | symmetric | 0.983 | 0.983 | 0.973 | 0.992 |
| prefix | gate | 8 | retrieval | 0.845 | 0.848 | 0.805 | 0.878 |
| construct_state | gate | 5 | symmetric | 0.979 | 0.975 | 0.966 | 0.996 |
| construct_state | gate | 5 | retrieval | 0.839 | 0.840 | 0.820 | 0.851 |
| final_letter | informational | 5 | symmetric | 0.973 | 0.976 | 0.947 | 0.992 |
| final_letter | informational | 5 | retrieval | 0.822 | 0.832 | 0.757 | 0.853 |
| typo | informational | 10 | symmetric | 0.906 | 0.905 | 0.876 | 0.952 |
| typo | informational | 10 | retrieval | 0.752 | 0.754 | 0.709 | 0.825 |
| ktiv_variance | informational | 3 | symmetric | 0.982 | 0.992 | 0.959 | 0.996 |
| ktiv_variance | informational | 3 | retrieval | 0.830 | 0.834 | 0.785 | 0.870 |
| synonym | semantic | 5 | symmetric | 0.930 | 0.929 | 0.896 | 0.962 |
| synonym | semantic | 5 | retrieval | 0.754 | 0.771 | 0.699 | 0.790 |
| cross_language | semantic | 5 | symmetric | 0.950 | 0.953 | 0.923 | 0.970 |
| cross_language | semantic | 5 | retrieval | 0.756 | 0.746 | 0.737 | 0.812 |
| hard_negative | control | 5 | symmetric | 0.880 | 0.889 | 0.843 | 0.905 |
| hard_negative | control | 5 | retrieval | 0.692 | 0.685 | 0.660 | 0.727 |
| unrelated | control | 10 | symmetric | 0.851 | 0.850 | 0.842 | 0.872 |
| unrelated | control | 10 | retrieval | 0.630 | 0.631 | 0.603 | 0.663 |

## Separation analysis (gate vs controls)

**Mode: symmetric** — gate median 0.976, control median 0.852, unrelated max 0.872, gate min 0.885. Gate pairs at/below unrelated max: 0.

**Mode: retrieval** — gate median 0.840, control median 0.633, unrelated max 0.663, gate min 0.760. Gate pairs at/below unrelated max: 0.

## Per-pair results

| Category | Query form | Catalog form | Gloss | symmetric | retrieval |
|---|---|---|---|---|---|
| plural_singular | סבונים | סבון | soaps / soap | 0.981 | 0.821 |
| plural_singular | מגבות | מגבת | towels / towel | 0.978 | 0.827 |
| plural_singular | שפתונים | שפתון | lipsticks / lipstick | 0.976 | 0.843 |
| plural_singular | קרמים | קרם | creams / cream | 0.975 | 0.840 |
| plural_singular | תחתונים | תחתון | underwear pl / sg | 0.974 | 0.841 |
| plural_singular | שקדים | שקד | almonds / almond | 0.973 | 0.858 |
| plural_singular | מסכות | מסכה | masks / mask | 0.972 | 0.858 |
| plural_singular | נרות | נר | candles / candle | 0.964 | 0.809 |
| plural_singular | שמנים | שמן | oils / oil | 0.956 | 0.819 |
| plural_singular | בשמים | בושם | perfumes / perfume (irregular) | 0.885 | 0.760 |
| prefix | הקרם | קרם | the-cream / cream | 0.992 | 0.858 |
| prefix | לגוף | גוף | for-body / body | 0.992 | 0.878 |
| prefix | ושקדים | שקדים | and-almonds / almonds | 0.990 | 0.848 |
| prefix | השמן | שמן | the-oil / oil | 0.988 | 0.871 |
| prefix | לעור | עור | for-skin / skin | 0.978 | 0.832 |
| prefix | מהטבע | טבע | from-the-nature / nature | 0.976 | 0.821 |
| prefix | בשמן | שמן | in-oil / oil | 0.976 | 0.848 |
| prefix | לשיער | שיער | for-hair / hair | 0.973 | 0.805 |
| construct_state | שמן שקדים | שמן השקדים | almond oil / the-almond oil | 0.996 | 0.840 |
| construct_state | מסכת שיער | מסכה לשיער | hair-mask (construct) / mask for hair | 0.986 | 0.843 |
| construct_state | שמני רחצה | שמן רחצה | bath oils / bath oil | 0.975 | 0.851 |
| construct_state | שמני גוף | שמן גוף | body oils (construct pl) / body oil | 0.971 | 0.840 |
| construct_state | קרם ידיים | קרם לידיים | hand cream / cream for hands | 0.966 | 0.820 |
| final_letter | סבונ | סבון | soap, non-final nun | 0.992 | 0.837 |
| final_letter | תחתונימ | תחתונים | underwear, non-final mem | 0.982 | 0.832 |
| final_letter | בושמ | בושם | perfume, non-final mem | 0.976 | 0.853 |
| final_letter | שקדימ | שקדים | almonds, non-final mem | 0.968 | 0.830 |
| final_letter | קרמימ | קרמים | creams, non-final mem | 0.947 | 0.757 |
| typo | תחתונם | תחתונים | underwear — deletion of yod | 0.952 | 0.825 |
| typo | שמן גיף | שמן גוף | body oil — substitution (spec example) | 0.925 | 0.769 |
| typo | קרם לגוך | קרם לגוף | body cream — final-letter substitution in phrase | 0.913 | 0.776 |
| typo | עןר | עור | skin — keyboard adjacency (spec example) | 0.906 | 0.714 |
| typo | סבין | סבון | soap — vav→yod substitution | 0.905 | 0.728 |
| typo | בושן | בושם | perfume — adjacent-key final substitution | 0.905 | 0.769 |
| typo | מגגבת | מגבת | towel — doubled letter insertion | 0.899 | 0.764 |
| typo | שדקים | שקדים | almonds — transposition (spec example) | 0.893 | 0.727 |
| typo | מגבץ | מגבת | towel — adjacent-key substitution | 0.886 | 0.744 |
| typo | שיאר | שיער | hair — phonetic ayin→alef | 0.876 | 0.709 |
| ktiv_variance | שאמפו | שמפו | shampoo — spelling variant | 0.996 | 0.834 |
| ktiv_variance | מסיכה | מסכה | mask — male/haser | 0.992 | 0.870 |
| ktiv_variance | זהר | זוהר | glow — haser/male (spec example) | 0.959 | 0.785 |
| synonym | ליפסטיק | שפתון | lipstick (loanword) / lipstick | 0.962 | 0.790 |
| synonym | ניחוח | בושם | scent / perfume | 0.956 | 0.771 |
| synonym | נצנצים | שימר | glitter / shimmer | 0.929 | 0.775 |
| synonym | הידרציה | לחות | hydration (loanword) / moisture | 0.905 | 0.736 |
| synonym | קרם הגנה | מסנן קרינה | sunscreen (two Hebrew terms) | 0.896 | 0.699 |
| cross_language | hand cream | קרם ידיים | EN / HE hand cream | 0.970 | 0.746 |
| cross_language | shampoo | שמפו | EN / HE shampoo | 0.962 | 0.740 |
| cross_language | body oil | שמן גוף | EN / HE body oil | 0.953 | 0.749 |
| cross_language | shimmer | שימר | EN / HE shimmer | 0.944 | 0.812 |
| cross_language | almond | שקד | EN / HE almond | 0.923 | 0.737 |
| hard_negative | עור | אור | skin / light — homophone | 0.905 | 0.727 |
| hard_negative | קרם | כרם | cream / vineyard — homophone | 0.893 | 0.715 |
| hard_negative | שמן | זמן | oil / time — edit dist 1 | 0.889 | 0.660 |
| hard_negative | חלב | כלב | milk / dog — edit dist 1 | 0.871 | 0.674 |
| hard_negative | שקד | שקט | almond / quiet — edit dist 1 | 0.843 | 0.685 |
| unrelated | שמן | מגבת | oil / towel | 0.872 | 0.639 |
| unrelated | שיער | אופניים | hair / bicycle | 0.857 | 0.633 |
| unrelated | בושם | מקרר | perfume / fridge | 0.853 | 0.616 |
| unrelated | גוף | עיפרון | body / pencil | 0.852 | 0.663 |
| unrelated | תחתונים | מחשב | underwear / computer | 0.850 | 0.630 |
| unrelated | קרם | נעליים | cream / shoes | 0.850 | 0.633 |
| unrelated | נרות | כיסא | candles / chair | 0.849 | 0.603 |
| unrelated | שקדים | משקפיים | almonds / glasses | 0.846 | 0.625 |
| unrelated | עור | שולחן | skin / table | 0.843 | 0.622 |
| unrelated | סבון | טלפון | soap / phone (rhymes) | 0.842 | 0.631 |

## Verdict

**GATE PASSED — proceed with `gemini-embedding-001` (3072) for Part 2.**

Ran 2026-07-28. Key findings:

1. **Morphology clusters cleanly (the spec §2.4 gate).** In retrieval mode — the mode
   production will use — every gate pair (plural/singular, prefix, construct state) scores
   0.760–0.878 while every unrelated control scores 0.603–0.663. Zero overlap, ~0.10 gap
   between the worst gate pair and the best control. The worst gate pair is the irregular
   plural `בשמים`/`בושם` (0.760) — still clear of controls, but irregular plurals are the
   weakest spot and should be watched in Part 2.

2. **Typo handling must be lexical, not embedding-based.** The hard negatives prove it:
   edit-distance-1 *distinct words* overlap the typo range in both modes. `עור`/`אור`
   (skin/light, 0.727 retrieval) actually scores **above** the real typo `עןר`→`עור` (0.714)
   and `שיאר`→`שיער` (0.709). Any embedding-similarity threshold loose enough to catch typos
   would also equate milk with dog (`חלב`/`כלב`, 0.674 vs typo floor 0.709 — a 0.035 margin,
   too thin to rely on). → In Part 2, typos are handled by BM25 `fuzziness` (which natively
   covers transpositions) and final letters by a `char_filter`; embeddings only need to not
   *hurt* on typo queries. This confirms the hybrid BM25+kNN design rather than kNN-only.

3. **Semantic layer expectation met.** Synonyms (0.699–0.790) and cross-language pairs
   (0.737–0.812) all clear the unrelated-control ceiling (0.663) in retrieval mode —
   consistent with embeddings carrying the synonym/intent recall role (spec §2.4).

4. **Free upside on the deferred ktiv-variance non-goal.** `זהר`/`זוהר` 0.785, `מסיכה`/`מסכה`
   0.870 — comparable to regular morphology pairs, so the embedding leg may pick these up
   without any dedicated work.

5. **Calibration note.** The model's cosine floor is high and mode-dependent (unrelated pairs
   ≈0.85 symmetric, ≈0.63 retrieval). Absolute thresholds must never be reused across task
   types; in retrieval we rely on relative ranking (RRF), not absolute cutoffs.

**Next:** Part 2 — index the il.loccitane.com catalog in OpenSearch (localhost:9200, 2.12.0
verified) and run the tiered query battery vs the live native search (see `plan.md`).
