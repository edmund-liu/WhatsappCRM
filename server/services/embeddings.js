// Text embeddings for the knowledge base (semantic retrieval).
//
// Uses a real embeddings API when one is configured in Settings — Voyage AI
// (Anthropic's recommended embeddings provider) or OpenAI — and otherwise
// falls back to a deterministic local vector so semantic-ish retrieval still
// works with zero setup (same "works out of the box" pattern as the AI
// responder's rule-based fallback). Embeddings from different providers aren't
// comparable, so every vector is tagged with a signature (provider:dim) and
// re-embedded on demand if the active provider changes.
import { getSetting } from '../db.js';

const LOCAL_DIM = 384;

async function embedConfig() {
  const provider = (await getSetting('embeddings_provider', 'local')) || 'local';
  const apiKey = (await getSetting('embeddings_api_key')) || process.env.EMBEDDINGS_API_KEY || null;
  if (provider !== 'local' && !apiKey) return { provider: 'local' };
  return { provider, apiKey };
}

// Deterministic bag-of-words hashing embedding. Tokens (and adjacent bigrams,
// for a little word-order signal) are hashed into a fixed-width vector; the
// result is L2-normalized so cosine similarity reduces to weighted token
// overlap. Not as good as a trained model, but stable, dependency-free, and
// good enough for FAQ-style lookups until a real provider key is set.
function localEmbed(text) {
  const vec = new Float64Array(LOCAL_DIM);
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const bump = (token, weight) => {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 16777619); }
    vec[Math.abs(h) % LOCAL_DIM] += weight;
  };
  for (let i = 0; i < tokens.length; i++) {
    bump(tokens[i], 1);
    if (i > 0) bump(tokens[i - 1] + '_' + tokens[i], 0.5);
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

async function voyageEmbed(texts, apiKey) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'voyage-3', input: texts }),
  });
  if (!res.ok) throw new Error(`Voyage API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

async function openaiEmbed(texts, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

// Embed a batch of strings. Returns { vectors, sig }. Falls back to the local
// embedder if a remote provider errors, so ingestion never hard-fails.
export async function embedBatch(texts) {
  const list = texts.map((t) => String(t || '').slice(0, 8000));
  const { provider, apiKey } = await embedConfig();
  if (provider === 'voyage' || provider === 'openai') {
    try {
      const vectors = provider === 'voyage' ? await voyageEmbed(list, apiKey) : await openaiEmbed(list, apiKey);
      return { vectors, sig: `${provider}:${vectors[0]?.length || 0}` };
    } catch (err) {
      console.error('Embeddings provider failed, using local fallback:', err.message);
    }
  }
  return { vectors: list.map(localEmbed), sig: `local:${LOCAL_DIM}` };
}

export async function embedOne(text) {
  const { vectors, sig } = await embedBatch([text]);
  return { vector: vectors[0], sig };
}

// Signature of the currently active provider — used to decide whether a stored
// embedding is comparable to a freshly computed query embedding.
export async function currentSig() {
  const { provider } = await embedConfig();
  if (provider === 'local') return `local:${LOCAL_DIM}`;
  return null; // remote dims are only known after a call; caller re-embeds on mismatch
}

export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are stored L2-normalized (local) or near-unit (providers)
}
