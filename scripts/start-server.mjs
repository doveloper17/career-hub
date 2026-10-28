// Keep the personal workspace on loopback on every operating system.
process.env.HOST = '127.0.0.1';
process.env.PORT ||= '4321';
await import('../dist/server/entry.mjs');
