// True when running on a serverless platform (Vercel): no background timers
// survive after a response is sent, the filesystem is ephemeral except /tmp,
// and work must be awaited before responding.
export const SERVERLESS = Boolean(process.env.VERCEL);
