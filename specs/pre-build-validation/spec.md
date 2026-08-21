> **The `benchmark/` tree is not in this repository.**
>
> Every `benchmark/...` path in the specs is a local path. The tree holds a
> scraped third-party catalog (499 products from a Hebrew reference store) and
> a live Gemini API key in `benchmark/.env`. Neither belongs in a public repo,
> so `.gitignore` excludes the whole directory.
>
> What survives here is the conclusion, not the raw data:
> `specs/pre-build-validation/part1-results.md` and `part2-results.md` carry
> the measured numbers, and `specs/specs.md` §1 carries what they decided.
> The scripts that produced them are reproducible from those two files.

- Hebrew embedding benchmark between Shopify native sematic search and our sematic search using Gemini API and opensearch: i think need to comibe kNN (k-Nearest Neighbors) — Semantic Search and BM25 — Keyword Search
- please using gemini:gemini-embedding-001 (dimension 3072) to embed data
- i'll provide GEMINI API KEY
