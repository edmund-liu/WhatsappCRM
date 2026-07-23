// AI auto-reply agents.
//
// When a conversation has an active AI agent attached, inbound customer
// messages are answered automatically. Uses the Anthropic API when an API key
// is configured in Settings; otherwise falls back to a small rule-based
// responder so the feature is demoable out of the box.
//
// Handoff: if the customer's message contains one of the agent's handoff
// keywords, the AI steps aside, the conversation is round-robin assigned to a
// human (if not already), and a system note records the handoff.
import db, { getSetting } from '../db.js';
import { emit } from './events.js';
import { sendText } from './whatsapp.js';
import { roundRobinAssign, addSystemNote } from './assignment.js';
import { recordResponse } from './sla.js';
import { fetchExternalData, externalDataContextBlock } from './externalData.js';

// Pick the AI agent for a new conversation: prefer one whose skills match the
// detected topic, then a generalist (no skills listed), then any auto-assign
// agent.
export async function pickAutoAssignAgent(skill = null) {
  const agents = await db.prepare('SELECT * FROM ai_agents WHERE is_active = 1 AND auto_assign_new = 1 ORDER BY id').all();
  if (agents.length === 0) return null;
  const skillsOf = (a) => { try { return JSON.parse(a.skills || '[]'); } catch { return []; } };
  if (skill) {
    const match = agents.find((a) => skillsOf(a).includes(skill));
    if (match) return match;
  }
  return agents.find((a) => skillsOf(a).length === 0) || agents[0];
}

function wantsHuman(text, agent) {
  let keywords = [];
  try { keywords = JSON.parse(agent.handoff_keywords || '[]'); } catch { /* ignore */ }
  const lower = text.toLowerCase();
  return keywords.some((k) => k && lower.includes(String(k).toLowerCase()));
}

// Turn a contact's custom-field values + any external data into a context
// block the AI can answer account-specific questions from.
export function contactContextBlock(contact) {
  const lines = [];
  let attrs = {};
  try { attrs = JSON.parse(contact?.attributes || '{}'); } catch { /* ignore */ }
  for (const [k, v] of Object.entries(attrs)) if (v) lines.push(`- ${k}: ${v}`);
  if (!lines.length) return '';
  return `\n\nKnown account details for this customer (use these to answer their questions directly instead of asking; never invent details beyond this list):\n${lines.join('\n')}`;
}

async function claudeReply(agent, history, contact) {
  const apiKey = (await getSetting('anthropic_api_key')) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const messages = history.map((m) => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.body || '[media message]',
  }));
  const externalBlock = externalDataContextBlock(await fetchExternalData(contact));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 512,
      system: `${agent.system_prompt}\n\nThe customer's name is ${contact?.name || 'unknown'}. You are replying inside WhatsApp: keep answers concise and conversational.${contactContextBlock(contact)}${externalBlock}\n\nIf you decide the customer needs a human, include the token [HANDOFF] at the end of your reply.`,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.content?.map((b) => b.text || '').join('') || null;
}

// Rule-based fallback so AI replies work with zero configuration.
function ruleReply(text) {
  const t = text.toLowerCase();
  if (/\b(hi|hello|hey|good (morning|afternoon|evening))\b/.test(t))
    return 'Hi there! 👋 Thanks for reaching out. How can I help you today?';
  if (t.includes('shipping') || t.includes('delivery'))
    return 'Standard shipping takes 3–5 business days and is free on orders over $50. 🚚';
  if (t.includes('return') || t.includes('refund'))
    return 'We offer a 30-day return policy on all items. Just reply with your order number and I can start the process.';
  if (t.includes('order') || t.includes('track'))
    return 'I can help with that! Please share your order number and I will look it up.';
  if (t.includes('price') || t.includes('cost') || t.includes('how much'))
    return 'You can find current pricing in our catalog. Is there a specific product you are interested in?';
  if (t.includes('hours') || t.includes('open'))
    return 'Our support team is online Monday to Saturday, 9am–6pm. I am here 24/7 though! 🤖';
  if (t.includes('thank'))
    return "You're welcome! Is there anything else I can help you with? 😊";
  return "Thanks for your message! I'll do my best to help — could you tell me a bit more? If you'd prefer a human, just say 'agent'.";
}

// Recap of the AI-handled portion so the human taking over has instant
// context without re-reading the whole thread. Uses Claude when a key is
// configured; otherwise builds a compact digest from the transcript.
async function buildHandoffSummary(conversation, agent) {
  const msgs = await db.prepare(
    "SELECT sender_type, body FROM messages WHERE conversation_id = ? AND sender_type IN ('contact','ai','agent') ORDER BY id"
  ).all(conversation.id);
  const contact = await db.prepare('SELECT name FROM contacts WHERE id = ?').get(conversation.contact_id);
  const apiKey = (await getSetting('anthropic_api_key')) || process.env.ANTHROPIC_API_KEY;
  if (apiKey && msgs.length) {
    try {
      const transcript = msgs.map((m) => `${m.sender_type === 'contact' ? 'Customer' : 'Assistant'}: ${m.body || '[media]'}`)
        .join('\n').slice(-4000);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: agent.model,
          max_tokens: 200,
          system: 'Summarize this WhatsApp support conversation in 2-3 short sentences for the human agent taking over. State what the customer needs and repeat any concrete details they gave (order/invoice numbers, amounts, dates). No preamble.',
          messages: [{ role: 'user', content: transcript }],
        }),
      });
      if (res.ok) {
        const json = await res.json();
        const text = json.content?.map((b) => b.text || '').join('').trim();
        if (text) return text;
      }
    } catch (err) {
      console.error('Handoff summary generation failed:', err.message);
    }
  }
  // Fallback digest without an API key.
  const customerMsgs = msgs.filter((m) => m.sender_type === 'contact' && m.body);
  const parts = [];
  if (conversation.required_skill) parts.push(`Topic: ${conversation.required_skill}.`);
  if (customerMsgs[0]) parts.push(`${contact?.name || 'Customer'} opened with: "${customerMsgs[0].body.slice(0, 120)}"`);
  const details = customerMsgs.slice(1, 4).map((m) => `"${m.body.slice(0, 90)}"`);
  if (details.length) parts.push(`Then said: ${details.join(' · ')}`);
  return parts.join(' ') || 'No prior messages.';
}

async function handoffToHuman(conversation, agent, reason) {
  await db.prepare('UPDATE conversations SET ai_enabled = 0 WHERE id = ?').run(conversation.id);
  await addSystemNote(conversation.id, `🤖 ${agent.name} handed off to a human (${reason})`);
  const summary = await buildHandoffSummary(conversation, agent);
  await addSystemNote(conversation.id, `📋 Handoff summary — ${summary}`);
  if (!conversation.assigned_user_id) {
    const human = await roundRobinAssign(conversation.id, conversation.required_skill);
    const note = human
      ? `You're being connected to ${human.name} from our team. They'll be with you shortly! 🙋`
      : "You're in the queue for our team — someone will be with you as soon as possible!";
    await sendAiText(conversation, agent, note);
  }
  emit('conversation_updated', { conversation_id: conversation.id });
}

async function sendAiText(conversation, agent, text) {
  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(conversation.contact_id);
  const waMessageId = await sendText(contact.wa_id, text);
  await db.prepare(
    "INSERT INTO messages (conversation_id, direction, sender_type, ai_agent_id, type, body, wa_message_id, status) VALUES (?, 'out', 'ai', ?, 'text', ?, ?, 'sent')"
  ).run(conversation.id, agent.id, text, waMessageId);
  await db.prepare('UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = ? WHERE id = ?')
    .run(`🤖 ${text}`.slice(0, 120), conversation.id);
  await recordResponse(conversation.id); // AI answering counts as a response
  emit('message_created', { conversation_id: conversation.id });
}

export async function maybeAutoReply(conversationId, inboundText) {
  const conversation = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation || !conversation.ai_enabled || !conversation.ai_agent_id) return;
  const agent = await db.prepare('SELECT * FROM ai_agents WHERE id = ? AND is_active = 1').get(conversation.ai_agent_id);
  if (!agent) return;

  if (wantsHuman(inboundText, agent)) {
    await handoffToHuman(conversation, agent, 'customer asked for a human');
    return;
  }

  const contact = await db.prepare('SELECT * FROM contacts WHERE id = ?').get(conversation.contact_id);
  const history = (await db.prepare(
    "SELECT direction, body FROM messages WHERE conversation_id = ? AND sender_type IN ('contact','agent','ai') ORDER BY id DESC LIMIT 20"
  ).all(conversationId)).reverse();

  let reply;
  try {
    reply = await claudeReply(agent, history, contact);
  } catch (err) {
    console.error('AI agent error, using fallback:', err.message);
  }
  if (!reply) reply = ruleReply(inboundText);

  const handoff = reply.includes('[HANDOFF]');
  reply = reply.replace('[HANDOFF]', '').trim();
  if (reply) await sendAiText(conversation, agent, reply);
  if (handoff) await handoffToHuman(conversation, agent, 'AI decided a human is needed');
}
