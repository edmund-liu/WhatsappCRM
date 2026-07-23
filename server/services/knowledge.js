// Knowledge base ingestion + retrieval.
//
// Ingestion turns raw material (pasted text, uploaded docs, mined
// conversations, fetched web pages) into embedded, reviewable knowledge
// entries. Retrieval finds the entries most relevant to an incoming customer
// message so the AI answers from your own curated answers.
import db from '../db.js';
import { embedBatch, embedOne, cosineSim } from './embeddings.js';

const MAX_CHUNK = 900;   // ~200 tokens per chunk
const MIN_CHUNK = 40;

// Split long text into chunks on paragraph boundaries, greedily packing up to
// ~MAX_CHUNK chars so each embedded entry is a coherent, self-contained piece.
export function chunkText(text) {
  const paras = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (p.length > MAX_CHUNK) {
      if (buf) { chunks.push(buf); buf = ''; }
      // Hard-split an oversized paragraph on sentence boundaries.
      for (const piece of p.match(/[^.!?]+[.!?]*/g) || [p]) {
        if ((buf + ' ' + piece).length > MAX_CHUNK && buf) { chunks.push(buf); buf = ''; }
        buf = buf ? `${buf} ${piece.trim()}` : piece.trim();
      }
      continue;
    }
    if ((buf + '\n\n' + p).length > MAX_CHUNK && buf) { chunks.push(buf); buf = ''; }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) chunks.push(buf);
  return chunks.filter((c) => c.length >= MIN_CHUNK);
}

async function insertEntries(rows, createdBy) {
  if (!rows.length) return { added: 0 };
  const { vectors, sig } = await embedBatch(rows.map((r) => `${r.title || ''}\n${r.content}`));
  let added = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await db.prepare(
      "INSERT INTO knowledge (source_type, source_ref, title, content, embedding, embed_sig, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)"
    ).run(r.source_type, r.source_ref || null, r.title || null, r.content, JSON.stringify(vectors[i]), sig, createdBy || null);
    added++;
  }
  return { added };
}

// Ingest a blob of text (pasted or an uploaded .txt/.md file) as chunks.
export async function ingestText({ text, title, sourceType = 'document', sourceRef = null, createdBy }) {
  const chunks = chunkText(text);
  const rows = chunks.map((content, i) => ({
    source_type: sourceType,
    source_ref: sourceRef,
    title: chunks.length > 1 ? `${title || sourceRef || 'Document'} (${i + 1}/${chunks.length})` : (title || sourceRef || null),
    content,
  }));
  return insertEntries(rows, createdBy);
}

// Ingest CSV with a question,answer (or single-column) layout. Q&A rows become
// one entry each; a single column is treated as free text and chunked.
export async function ingestCsv({ text, sourceRef = null, createdBy }) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { added: 0 };
  const parseRow = (line) => {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells.map((s) => s.trim());
  };
  const first = parseRow(lines[0]).map((c) => c.toLowerCase());
  const hasHeader = first.some((c) => ['question', 'answer', 'q', 'a', 'title', 'content'].includes(c));
  const body = hasHeader ? lines.slice(1) : lines;
  const rows = [];
  for (const line of body) {
    const cells = parseRow(line);
    if (cells.length >= 2 && cells[0] && cells[1]) rows.push({ source_type: 'document', source_ref: sourceRef, title: cells[0], content: cells[1] });
    else if (cells[0]) rows.push({ source_type: 'document', source_ref: sourceRef, title: null, content: cells[0] });
  }
  return insertEntries(rows, createdBy);
}

// Mine resolved conversations into Q&A pairs: each customer question followed
// by a substantive team/AI answer becomes a candidate entry. Skips pairs
// already mined (same conversation + question) so re-running is idempotent.
export async function mineConversations({ createdBy, limit = 200 } = {}) {
  const convs = await db.prepare(
    "SELECT id FROM conversations WHERE status = 'resolved' ORDER BY id DESC LIMIT ?"
  ).all(limit);
  const existing = new Set(
    (await db.prepare("SELECT source_ref, title FROM knowledge WHERE source_type = 'conversation'").all())
      .map((r) => `${r.source_ref}::${r.title}`)
  );
  // Generic AI holding replies aren't real answers — don't mine them.
  const FILLER = /do my best to help|could you tell me a bit more|connect(ed)? (you )?to (a|our)|in the queue|being connected/i;
  const candidates = [];
  for (const { id } of convs) {
    const msgs = await db.prepare(
      "SELECT sender_type, body FROM messages WHERE conversation_id = ? AND type = 'text' ORDER BY id"
    ).all(id);
    for (let i = 0; i < msgs.length; i++) {
      const q = msgs[i];
      if (q.sender_type !== 'contact' || (q.body || '').trim().length <= 8) continue;
      // Collect answers in this turn (until the next customer message), then
      // prefer the human agent's reply over an AI reply, skipping filler.
      const turn = [];
      for (let j = i + 1; j < msgs.length && msgs[j].sender_type !== 'contact'; j++) {
        const a = msgs[j];
        if ((a.sender_type === 'agent' || a.sender_type === 'ai') && (a.body || '').trim().length > 15 && !FILLER.test(a.body)) turn.push(a);
      }
      const answer = turn.find((a) => a.sender_type === 'agent') || turn[0];
      if (!answer) continue;
      const title = q.body.trim().slice(0, 240);
      const key = `${id}::${title}`;
      if (existing.has(key)) continue;
      existing.add(key);
      candidates.push({ source_type: 'conversation', source_ref: String(id), title, content: answer.body.trim() });
    }
  }
  return insertEntries(candidates, createdBy);
}

// Fetch a web page (help-center article, FAQ) and ingest its text. Outbound
// fetch may be restricted in the sandbox; works once deployed.
export async function ingestUrl({ url, createdBy }) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'WhatsAppCRM-KnowledgeBot/1.0' }, redirect: 'follow' });
  } catch (err) {
    throw new Error(`Could not fetch the URL: ${err.message}`);
  }
  if (!res.ok) throw new Error(`Fetch failed (HTTP ${res.status}) for ${url}`);
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n');
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return ingestText({ text, title: (titleMatch?.[1] || url).trim(), sourceType: 'url', sourceRef: url, createdBy });
}

// Retrieve the top-K active knowledge entries most similar to `query`.
// Self-heals stored embeddings whose signature no longer matches the active
// provider by re-embedding them once.
export async function retrieve(query, k = 4, minScore = 0.25) {
  const rows = await db.prepare("SELECT id, title, content, embedding, embed_sig FROM knowledge WHERE status = 'active'").all();
  if (!rows.length) return [];
  const { vector: qvec, sig: qsig } = await embedOne(query);

  // Re-embed any active rows made with a different provider so scores compare.
  const stale = rows.filter((r) => r.embed_sig !== qsig);
  if (stale.length) {
    const { vectors, sig } = await embedBatch(stale.map((r) => `${r.title || ''}\n${r.content}`));
    for (let i = 0; i < stale.length; i++) {
      stale[i].embedding = JSON.stringify(vectors[i]);
      stale[i].embed_sig = sig;
      await db.prepare('UPDATE knowledge SET embedding = ?, embed_sig = ? WHERE id = ?').run(stale[i].embedding, sig, stale[i].id);
    }
  }

  const scored = rows.map((r) => {
    let vec = null;
    try { vec = JSON.parse(r.embedding || 'null'); } catch { /* ignore */ }
    return { ...r, score: vec ? cosineSim(qvec, vec) : 0 };
  }).filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score).slice(0, k);
  return scored;
}

// A context block for the AI agent's system prompt, built from retrieved
// knowledge. Empty string when nothing relevant is found.
export async function knowledgeContextBlock(query) {
  const hits = await retrieve(query);
  if (!hits.length) return '';
  const items = hits.map((h) => `- ${h.title ? h.title + ': ' : ''}${h.content}`).join('\n');
  return `\n\nRelevant knowledge base entries (answer from these when they apply; do not contradict them or invent details beyond them):\n${items}`;
}
