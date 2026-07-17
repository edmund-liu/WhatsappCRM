// Meta WhatsApp Cloud API webhook.
//
// GET  /webhook/whatsapp  -> subscription verification handshake
// POST /webhook/whatsapp  -> inbound messages + delivery status updates
import { Router } from 'express';
import { getSetting } from '../db.js';
import { handleInboundMessage } from '../services/inbound.js';
import { applyStatusUpdate } from '../services/whatsapp.js';

const router = Router();

router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === getSetting('wa_verify_token')) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/whatsapp', (req, res) => {
  // Always ack fast; Meta retries on non-200 and requires a quick response.
  res.sendStatus(200);
  try {
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contactNames = {};
        for (const c of value.contacts || []) contactNames[c.wa_id] = c.profile?.name;

        for (const msg of value.messages || []) {
          const text =
            msg.text?.body ??
            msg.button?.text ??
            msg.interactive?.button_reply?.title ??
            msg.interactive?.list_reply?.title ??
            `[${msg.type} message]`;
          handleInboundMessage({
            waId: msg.from,
            name: contactNames[msg.from],
            text,
            waMessageId: msg.id,
            type: msg.type === 'text' ? 'text' : msg.type,
          }).catch((err) => console.error('Inbound handling error:', err));
        }

        for (const status of value.statuses || []) {
          applyStatusUpdate(status.id, status.status);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

export default router;
