import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api.js';
import webhookRouter from './routes/webhook.js';
import chatRouter from './routes/chat.js';
import { startScheduler } from './services/broadcaster.js';
import { SERVERLESS } from './runtime.js';
import { UPLOADS_DIR } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use('/api', apiRouter);
app.use('/webhook', webhookRouter);
app.use('/chat', chatRouter); // public web-chat channel (widget backend)
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// On serverless (Vercel) the platform invokes the app per request: no listen,
// and no interval-based scheduler (scheduled broadcasts need an always-on host).
if (!SERVERLESS) {
  startScheduler();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`WhatsApp CRM running on http://localhost:${PORT}`);
    console.log('Default login: admin@example.com / admin123');
  });
}

export default app;
