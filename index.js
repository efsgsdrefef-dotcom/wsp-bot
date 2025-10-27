import express from 'express';
import fs from 'fs';
import { Boom } from '@hapi/boom';
import NodeCache from '@cacheable/node-cache';
import readline from 'readline';
import makeWASocket, { DisconnectReason, delay, fetchLatestBaileysVersion, useMultiFileAuthState, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import P from 'pino';
import axios from 'axios';
import yts from 'yt-search';
import ytdl from 'ytdl-core';
import * as Jimp from 'jimp';
import fsExtra from 'fs-extra';

// --- EXPRESS SERVER ---
const app = express();
app.get("/", (req, res) => res.send("Bot FULL ON ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP Server Running ✔ PORT:${PORT}`));

// --- LOGGER ---
const logger = P({
  level: "trace",
  transport: {
    targets: [
      { target: "pino-pretty", options: { colorize: true, level: "trace" } },
      { target: "pino/file", options: { destination: './wa-logs.txt', level: "trace" } }
    ]
  }
});

// --- Readline ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

// --- Cache para mensajes ---
const msgRetryCounterCache = new NodeCache();

// --- START BOT FULL ---
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
    if(events['connection.update']) {
      const { connection, lastDisconnect } = events['connection.update'];
      if(connection === 'close') {
        if((lastDisconnect?.error?.output?.statusCode) !== DisconnectReason.loggedOut) startSock();
        else console.log('Connection closed. You are logged out.');
      }
      if(events['connection.update'].qr) console.log('SCAN QR 🔥🔥');
    }

    if(events['creds.update']) await saveCreds();

    if(events['messages.upsert']) {
      const upsert = events['messages.upsert'];
      for(const msg of upsert.messages){
        if(msg.message?.conversation){
          const text = msg.message.conversation.toLowerCase();
          const from = msg.key.remoteJid;

          // --- COMANDOS ---
          if(text.startsWith('#sticker')){
            // sticker de imagen
            try {
              const mediaUrl = text.split(' ')[1];
              const image = await Jimp.read(mediaUrl);
              const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
              await sock.sendMessage(from, { sticker: buffer });
            } catch(e){ console.log('Error sticker:', e); }
          }

          if(text.startsWith('#ytaudio')){
            try {
              const query = text.replace('#ytaudio','').trim();
              const r = await yts(query);
              const video = r.videos.length > 0 ? r.videos[0] : null;
              if(video){
                const stream = ytdl(video.url, { filter: 'audioonly' });
                const filePath = `audio.mp3`;
                const writeStream = fs.createWriteStream(filePath);
                stream.pipe(writeStream);
                writeStream.on('finish', async ()=>{
                  await sock.sendMessage(from, { audio: fs.readFileSync(filePath), mimetype: 'audio/mpeg' });
                  fs.unlinkSync(filePath);
                });
              }
            } catch(e){ console.log('Error ytaudio:', e); }
          }

          if(text.startsWith('#ytvideo')){
            try {
              const query = text.replace('#ytvideo','').trim();
              const r = await yts(query);
              const video = r.videos.length > 0 ? r.videos[0] : null;
              if(video){
                await sock.sendMessage(from, { text: `Video link: ${video.url}` });
              }
            } catch(e){ console.log('Error ytvideo:', e); }
          }

          if(text.includes('hola')){
            await sock.sendMessage(from, { text: 'Hola bro 😎🔥' });
          }

          if(text.includes('link')){
            await sock.sendMessage(from, { text: 'Anti-link activo 🚫' });
          }

        }
      }
    }
  });

  return sock;

  async function getMessage(key){
    return { conversation: 'test' };
  }
}

startSock();
