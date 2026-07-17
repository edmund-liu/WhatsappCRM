// Simple Server-Sent Events bus so the inbox updates in real time.
const clients = new Set();

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const client = { res };
  clients.add(client);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}
