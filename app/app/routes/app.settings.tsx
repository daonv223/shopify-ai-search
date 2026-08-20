import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { validateEmbeddingKey } from "../services/embedding.server";
import { lexicalSearch } from "../services/search.server";
import {
  BOOSTABLE_FIELDS,
  BOOST_MAX,
  BOOST_MIN,
  DEFAULT_BOOSTS,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_PROVIDERS,
  getSearchConfig,
  searchConfigRow,
  updateSearchConfig,
  type BoostConfig,
  type SynonymGroup,
} from "../services/search-config.server";

type PreviewList = { title: string; handle: string }[];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const config = await getSearchConfig(session.shop);
  return {
    config,
    defaults: DEFAULT_BOOSTS,
    fields: BOOSTABLE_FIELDS,
    providers: EMBEDDING_PROVIDERS,
    defaultModel: DEFAULT_EMBEDDING_MODEL,
    boostRange: { min: BOOST_MIN, max: BOOST_MAX },
  };
};

function parseBoosts(form: FormData): BoostConfig {
  const out = { ...DEFAULT_BOOSTS };
  for (const field of BOOSTABLE_FIELDS) {
    const raw = Number(form.get(`boost.${field}`));
    if (Number.isFinite(raw)) out[field] = raw;
  }
  return out;
}

function parseSynonyms(raw: FormDataEntryValue | null): SynonymGroup[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((g) => ({
        terms: Array.isArray(g?.terms)
          ? g.terms.map((t: unknown) => String(t).trim()).filter(Boolean)
          : String(g?.terms ?? "")
              .split(/[,،]/)
              .map((t) => t.trim())
              .filter(Boolean),
        oneWay: Boolean(g?.oneWay),
      }))
      .filter((g) => g.terms.length >= 2);
  } catch {
    return [];
  }
}

// Lexical-only preview: boosts and synonyms are both lexical-leg levers, so the
// lexical top-N shows their effect deterministically without a Gemini call.
async function preview(
  alias: string,
  query: string,
  boosts: BoostConfig,
  synonyms: SynonymGroup[],
): Promise<PreviewList> {
  const res = await lexicalSearch(alias, query, 8, { boosts, synonyms });
  return res.hits.map((h) => ({ title: h.title, handle: h.handle }));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "save-provider") {
    const provider = String(form.get("provider") ?? "gemini");
    const model = String(form.get("model") ?? DEFAULT_EMBEDDING_MODEL).trim() || DEFAULT_EMBEDDING_MODEL;
    const newKey = String(form.get("apiKey") ?? "").trim();
    const existing = await searchConfigRow(shop);
    const keyToValidate = newKey || existing?.embeddingApiKey || "";
    if (!keyToValidate) {
      return { intent, ok: false, message: "Enter an API key to validate." };
    }
    const check = await validateEmbeddingKey(provider, model, keyToValidate);
    if (!check.ok) {
      return { intent, ok: false, message: `Key validation failed: ${check.error}` };
    }
    await updateSearchConfig(shop, {
      embeddingProvider: provider,
      embeddingModel: model,
      // Only overwrite the stored key when a new one was entered.
      ...(newKey ? { embeddingApiKey: newKey } : {}),
    });
    return { intent, ok: true, message: "Provider settings saved." };
  }

  if (intent === "save-boosts") {
    await updateSearchConfig(shop, { boosts: parseBoosts(form) });
    return { intent, ok: true, message: "Boosts saved." };
  }

  if (intent === "save-synonyms") {
    await updateSearchConfig(shop, { synonyms: parseSynonyms(form.get("synonyms")) });
    return { intent, ok: true, message: "Synonyms saved." };
  }

  if (intent === "preview") {
    const query = String(form.get("query") ?? "").trim();
    if (!query) return { intent, ok: false, message: "Enter a query to preview." };
    const row = await db.shop.findUnique({ where: { id: shop } });
    if (!row) return { intent, ok: false, message: "Shop not found." };
    const saved = await getSearchConfig(shop);
    const candidateBoosts = parseBoosts(form);
    const candidateSynonyms = parseSynonyms(form.get("synonyms"));
    const [before, after] = await Promise.all([
      preview(row.indexAlias, query, saved.boosts, saved.synonyms),
      preview(row.indexAlias, query, candidateBoosts, candidateSynonyms),
    ]);
    return { intent, ok: true, query, before, after };
  }

  return { intent: String(intent ?? ""), ok: false, message: "Unknown action." };
};

// ── UI ──────────────────────────────────────────────────────────────────────

type SynonymRow = { terms: string; oneWay: boolean };

export default function Settings() {
  const { config, defaults, fields, providers, defaultModel, boostRange } =
    useLoaderData<typeof loader>();

  const [boosts, setBoosts] = useState<Record<string, number>>({ ...config.boosts });
  const [synonyms, setSynonyms] = useState<SynonymRow[]>(
    config.synonyms.map((g) => ({ terms: g.terms.join(", "), oneWay: g.oneWay })),
  );

  const synonymsJson = JSON.stringify(
    synonyms.map((s) => ({ terms: s.terms, oneWay: s.oneWay })),
  );

  return (
    <s-page heading="Search settings">
      <ProviderSection providers={providers} config={config} defaultModel={defaultModel} />
      <BoostsSection
        fields={fields}
        defaults={defaults}
        boosts={boosts}
        setBoosts={setBoosts}
        range={boostRange}
        synonymsJson={synonymsJson}
      />
      <SynonymsSection
        synonyms={synonyms}
        setSynonyms={setSynonyms}
        synonymsJson={synonymsJson}
        boosts={boosts}
      />
    </s-page>
  );
}

function Feedback({ data }: { data: { ok?: boolean; message?: string } | undefined }) {
  if (!data?.message) return null;
  return (
    <s-banner tone={data.ok ? "success" : "critical"}>
      <s-paragraph>{data.message}</s-paragraph>
    </s-banner>
  );
}

function ProviderSection({
  providers,
  config,
  defaultModel,
}: {
  providers: readonly string[];
  config: { embeddingProvider: string; embeddingModel: string; hasApiKey: boolean };
  defaultModel: string;
}) {
  const fetcher = useFetcher<{ ok?: boolean; message?: string }>();
  const busy = ["loading", "submitting"].includes(fetcher.state);
  return (
    <s-section heading="Embedding provider">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="save-provider" />
        <s-stack gap="base">
          <s-select name="provider" label="Provider" value={config.embeddingProvider}>
            {providers.map((p) => (
              <s-option key={p} value={p}>
                {p}
              </s-option>
            ))}
            <s-option value="openai" disabled>
              openai (coming soon — switching provider needs a re-embed)
            </s-option>
          </s-select>
          <s-text-field name="model" label="Model" value={config.embeddingModel || defaultModel} />
          <s-password-field
            name="apiKey"
            label="API key"
            placeholder={config.hasApiKey ? "•••••••• (leave blank to keep current)" : "Enter API key"}
          />
          <s-paragraph>
            The key is validated with a one-vector test call before it is saved, and is never
            shown again.
          </s-paragraph>
          <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
            Validate &amp; save
          </s-button>
          <Feedback data={fetcher.data} />
        </s-stack>
      </fetcher.Form>
    </s-section>
  );
}

function BoostsSection({
  fields,
  defaults,
  boosts,
  setBoosts,
  range,
  synonymsJson,
}: {
  fields: readonly string[];
  defaults: Record<string, number>;
  boosts: Record<string, number>;
  setBoosts: (b: Record<string, number>) => void;
  range: { min: number; max: number };
  synonymsJson: string;
}) {
  const fetcher = useFetcher<{ ok?: boolean; message?: string }>();
  const busy = ["loading", "submitting"].includes(fetcher.state);
  return (
    <s-section heading="Field boosts">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="save-boosts" />
        <s-stack gap="base">
          <s-paragraph>
            Per-field weights over the search defaults. Higher weight ranks matches in that
            field above others. Applies immediately — no re-index.
          </s-paragraph>
          {fields.map((field) => (
            <s-number-field
              key={field}
              name={`boost.${field}`}
              label={`${field} (default ${defaults[field]})`}
              value={String(boosts[field])}
              min={range.min}
              max={range.max}
              step={0.1}
              onInput={(e: { currentTarget: { value: string } }) =>
                setBoosts({ ...boosts, [field]: Number(e.currentTarget.value) })
              }
            />
          ))}
          <s-button-group>
            <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
              Save boosts
            </s-button>
            <s-button type="button" onClick={() => setBoosts({ ...defaults })}>
              Reset to defaults
            </s-button>
          </s-button-group>
          <Feedback data={fetcher.data} />
        </s-stack>
      </fetcher.Form>
      <PreviewPanel boosts={boosts} synonymsJson={synonymsJson} />
    </s-section>
  );
}

function SynonymsSection({
  synonyms,
  setSynonyms,
  synonymsJson,
  boosts,
}: {
  synonyms: SynonymRow[];
  setSynonyms: (s: SynonymRow[]) => void;
  synonymsJson: string;
  boosts: Record<string, number>;
}) {
  const fetcher = useFetcher<{ ok?: boolean; message?: string }>();
  const busy = ["loading", "submitting"].includes(fetcher.state);
  const update = (i: number, patch: Partial<SynonymRow>) =>
    setSynonyms(synonyms.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => setSynonyms(synonyms.filter((_, j) => j !== i));
  const add = () => setSynonyms([...synonyms, { terms: "", oneWay: false }]);

  return (
    <s-section heading="Synonyms">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="save-synonyms" />
        <input type="hidden" name="synonyms" value={synonymsJson} />
        <s-stack gap="base">
          <s-paragraph>
            Group terms that should match each other. Comma-separate the terms in a group.
            &ldquo;One-way&rdquo; expands only from the first term to the rest. Applies at
            query time — no re-index.
          </s-paragraph>
          {synonyms.length === 0 ? <s-paragraph>No synonym groups yet.</s-paragraph> : null}
          {synonyms.map((row, i) => (
            <s-stack key={i} direction="inline" gap="base" alignItems="end">
              <s-text-field
                label={`Group ${i + 1}`}
                value={row.terms}
                placeholder="שמן, אולי"
                onInput={(e: { currentTarget: { value: string } }) =>
                  update(i, { terms: e.currentTarget.value })
                }
              />
              <s-switch
                label="One-way"
                checked={row.oneWay}
                onChange={(e: { currentTarget: { checked: boolean } }) =>
                  update(i, { oneWay: e.currentTarget.checked })
                }
              />
              <s-button type="button" tone="critical" onClick={() => remove(i)}>
                Remove
              </s-button>
            </s-stack>
          ))}
          <s-button-group>
            <s-button type="button" onClick={add}>
              Add group
            </s-button>
            <s-button type="submit" variant="primary" {...(busy ? { loading: true } : {})}>
              Save synonyms
            </s-button>
          </s-button-group>
          <Feedback data={fetcher.data} />
        </s-stack>
      </fetcher.Form>
      <PreviewPanel boosts={boosts} synonymsJson={synonymsJson} />
    </s-section>
  );
}

// Live before/after preview shared by the boosts and synonyms sections. Submits
// the candidate (unsaved) config and shows the saved vs candidate lexical top-8.
function PreviewPanel({
  boosts,
  synonymsJson,
}: {
  boosts: Record<string, number>;
  synonymsJson: string;
}) {
  const fetcher = useFetcher<{
    ok?: boolean;
    message?: string;
    query?: string;
    before?: PreviewList;
    after?: PreviewList;
  }>();
  const busy = ["loading", "submitting"].includes(fetcher.state);
  const data = fetcher.data;

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="preview" />
        <input type="hidden" name="synonyms" value={synonymsJson} />
        {Object.entries(boosts).map(([f, v]) => (
          <input key={f} type="hidden" name={`boost.${f}`} value={String(v)} />
        ))}
        <s-stack gap="base">
          <s-heading>Live preview</s-heading>
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-search-field name="query" label="Query" placeholder="Type a search term" />
            <s-button type="submit" {...(busy ? { loading: true } : {})}>
              Preview
            </s-button>
          </s-stack>
          {data?.message ? <s-paragraph>{data.message}</s-paragraph> : null}
          {data?.before && data?.after ? (
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <PreviewColumn heading="Saved (before)" list={data.before} />
              <PreviewColumn heading="Candidate (after)" list={data.after} />
            </s-grid>
          ) : null}
        </s-stack>
      </fetcher.Form>
    </s-box>
  );
}

function PreviewColumn({ heading, list }: { heading: string; list: PreviewList }) {
  return (
    <s-stack gap="small-500">
      <s-heading>{heading}</s-heading>
      {list.length === 0 ? (
        <s-text>No results</s-text>
      ) : (
        <s-ordered-list>
          {list.map((item, i) => (
            <s-list-item key={`${item.handle}-${i}`}>{item.title}</s-list-item>
          ))}
        </s-ordered-list>
      )}
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
