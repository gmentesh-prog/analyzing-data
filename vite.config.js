import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function beatportPlugin() {
  return {
    name: 'beatport-dev',
    configureServer(server) {
      server.middlewares.use('/api/beatport-genre', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const query = Object.fromEntries(url.searchParams.entries());
        if (!query.q && !query.isrc) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing params' })); return; }
        const mod = await import('./api/beatport-genre.js');
        const handler = mod.default;
        const fakeReq = { query };
        const result = {};
        const fakeRes = { status: (code) => ({ json: (data) => { result.code = code; result.data = data; } }), setHeader: () => {} };
        await handler(fakeReq, fakeRes);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result.data || {}));
      });
    },
  };
}

export default defineConfig({
  plugins: [beatportPlugin(), react()],
  server: { port: 5174 },
})
