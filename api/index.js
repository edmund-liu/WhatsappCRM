// Vercel serverless entry point: wraps the Express app.
// /api/* and /webhook/* are rewritten here (see vercel.json); static assets
// in public/ are served by Vercel's CDN directly.
import app from '../server/index.js';

export default app;
