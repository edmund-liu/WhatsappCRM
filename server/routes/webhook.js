// Meta WhatsApp Cloud API webhook.
//
// GET  /webhook/whatsapp  -> subscription verification handshake
// POST /webhook/whatsapp  -> inbound messages + delivery status updates
import { Router } from 'express';
import db, { getSetting, UPLOADS_DIR } from '../db.js';
import { SERVERLESS } from '../runtime.js';
import { handleInboundMessage } from '../services/inbound.js';
import { applyStatusUpdate, downloadMediaById } from '../services/whatsapp.js';

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

router.post('/whatsapp', async (req, res) => {
  // Always-on servers ack immediately (Meta retries on non-200 and requires a
  // quick response) and process afterwards. Serverless freezes the process
  // once the response is sent, so there the work happens first.
  if (!SERVERLESS) res.sendStatus(200);
  try {
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // Meta approved/rejected/paused a template -> sync status locally.
        if (change.field === 'message_template_status_update') {
          if (value.message_template_name && value.event) {
            db.prepare('UPDATE templates SET status = ? WHERE name = ?')
              .run(value.event, value.message_template_name);
          }
          continue;
        }
        const contactNames = {};
        for (const c of value.contacts || []) contactNames[c.wa_id] = c.profile?.name;

        for (const msg of value.messages || []) {
          // Media messages (images, voice notes, video, documents) carry a
          // Meta media ID — download the file so the inbox can show it.
          const mediaMsg = msg.image || msg.audio || msg.video || msg.document || msg.sticker;
          const mediaKind = msg.image || msg.sticker ? 'image' : msg.audio ? 'audio' : msg.video ? 'video' : msg.document ? 'document' : null;
          let mediaUrl = null;
          if (mediaMsg?.id) {
            try {
              mediaUrl = await downloadMediaById(mediaMsg.id, UPLOADS_DIR);
            } catch (err) {
              console.error('Inbound media download failed:', err.message);
            }
          }
          const text =
            msg.text?.body ??
            mediaMsg?.caption ??
            msg.button?.text ??
            msg.interactive?.button_reply?.title ??
            msg.interactive?.list_reply?.title ??
            (mediaKind ? '' : `[${msg.type} message]`);
          const handling = handleInboundMessage({
            waId: msg.from,
            name: contactNames[msg.from],
            text,
            waMessageId: msg.id,
            type: mediaKind || (msg.type === 'text' ? 'text' : msg.type),
            mediaUrl,
          }).catch((err) => console.error('Inbound handling error:', err));
          if (SERVERLESS) await handling;
        }

        for (const status of value.statuses || []) {
          const error = status.errors?.[0]
            ? `${status.errors[0].title || ''} ${status.errors[0].error_data?.details || ''}`.trim()
            : null;
          applyStatusUpdate(status.id, status.status, error);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
  if (SERVERLESS) res.sendStatus(200);
});

export default router;
