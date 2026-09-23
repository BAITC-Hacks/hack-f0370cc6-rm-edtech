import { fileURLToPath } from 'node:url';

// Explicit, local-only demonstration. The router also rejects demo on non-loopback origins.
process.env.PLATFORM_DEMO = '1';
process.argv[1] = fileURLToPath(new URL('../server.mjs',import.meta.url));
await import('../server.mjs');
