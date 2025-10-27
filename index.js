import { Boom } from '@hapi/boom';
import NodeCache from '@cacheable/node-cache';
import readline from 'readline';
import makeWASocket, { delay, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState } from '@adiwajshing/baileys';
import P from 'pino';
import fs from 'fs';

// Logger
const logger = P({
  level: "trace",
  transport: {
    targets: [
      { target: "pino-pretty", options: { colorize: true, level: "trace" } },
      { target: "pino/file", options: { destination: './wa-logs.txt', level: "trace" } }
    ]
  }
});
logger.level = 'trace';

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

const msgRetryCounterCache = new NodeCache(); // Cache de reintentos

// --- START BOT ---
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    getMessage
  });

  sock.ev.process(async (events) => {
    // connection update
    if (events['connection.update']) {
      const { connection, lastDisconnect } = events['connection.update'];
      if (connection === 'close') {
        if ((lastDisconnect?.error?.output?.statusCode) !== DisconnectReason.loggedOut) {
          startSock();
        } else {
          console.log('Connection closed. You are logged out.');
        }
      }
      console.log('connection update', events['connection.update']);
    }

    if (events['creds.update']) await saveCreds();

    if (events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      console.log('recv messages ', JSON.stringify(upsert, null, 2));
      for (const msg of upsert.messages) {
        if (!msg.key.fromMe) {
          console.log('Message from', msg.key.remoteJid, '->', msg.message?.conversation || msg.message?.extendedTextMessage?.text);
        }
      }
    }
  });

  return sock;

  async function getMessage(key) {
    // Devuelve un mensaje de prueba para placeholder
    return { conversation: 'test' };
  }
}

startSock();
