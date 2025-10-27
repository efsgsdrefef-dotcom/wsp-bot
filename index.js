import express from 'express';
import fs from 'fs';
import NodeCache from '@cacheable/node-cache';
import readline from 'readline';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import P from 'pino';
import yts from 'yt-search';
import ytdl from 'ytdl-core';
import * as Jimp from 'jimp';
import QRCode from 'qrcode';
import fsExtra from 'fs-extra';

// --- EXPRESS SERVER ---
const app = express();
app.get("/", (req, res) => res.send("Bot FULL ON ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP Server Running ✔ PORT:${PORT}`));

// --- LOGGER ---
const logger = P({ level: 'trace' });

// --- Readline ---
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

// --- Cache para mensajes ---
const msgRetryCounterCache = new NodeCache();

// --- VARIABLE PARA QR ---
let latestQR = null;

// --- ENDPOINT PARA VER EL QR ---
app.get("/qr", (req, res) => {
  if(latestQR){
    res.send(`<img src="${latestQR}" alt="QR para WhatsApp">`);
  } else {
    res.send('QR aún no generado. Reinicia el bot si es necesario.');
  }
});

// --- START BOT FULL ---
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('session');
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
      const { connection, lastDisconnect, qr } = events['connection.update'];

      // --- NUEVO: GUARDAR QR ---
      if(qr){
        latestQR = await QRCode.toDataURL(qr);
        console.log('QR generado! Abre /qr en tu navegador para escanearlo.');
      }

      if(connection === 'close') {
        if((lastDisconnect?.error?.output?.statusCode) !== DisconnectReason.loggedOut) {
          console.log('Reconectando...');
          startSock();
        } else {
          console.log('Connection closed. You are logged out.');
        }
      }
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
            try {
              const mediaUrl = text.split(' ')[1];
              if(!mediaUrl) return await sock.sendMessage(from, { text: 'Debes enviar una URL de imagen.' });
              const image = await Jimp.read(mediaUrl);
              const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
              await sock.sendMessage(from, { sticker: buffer });
            } catch(e){ 
              console.log('Error sticker:', e); 
              await sock.sendMessage(from, { text: 'Error al crear sticker.' });
            }
          }

          if(text.startsWith('#ytaudio')){
  try {
    const query = text.replace('#ytaudio','').trim();
    const r = await yts(query);
    const video = r.videos.length > 0 ? r.videos[0] : null;
    if(!video) return await sock.sendMessage(from, { text: 'No se encontró audio 😔' });

    const filePath = `audio.mp3`;
    const stream = ytdl(video.url, { filter: 'audioonly', highWaterMark: 1<<25 }); // buffer grande para no saturar
    const writeStream = fs.createWriteStream(filePath);

    // Manejo de errores en stream
    stream.on('error', async (err) => {
      console.log('Error en ytdl stream:', err);
      await sock.sendMessage(from, { text: 'Error descargando el audio 😔' });
      if(fs.existsSync(filePath)) fsExtra.removeSync(filePath);
    });

    // Timeout: si tarda más de 60s, cancelar
    const timeout = setTimeout(() => {
      stream.destroy();
      if(fs.existsSync(filePath)) fsExtra.removeSync(filePath);
      sock.sendMessage(from, { text: 'La descarga tardó demasiado y fue cancelada ⏱️' });
    }, 60000);

    stream.pipe(writeStream);
    writeStream.on('finish', async ()=>{
      clearTimeout(timeout);
      try {
        await sock.sendMessage(from, { audio: fs.readFileSync(filePath), mimetype: 'audio/mpeg' });
      } catch(err){
        console.log('Error enviando audio:', err);
        await sock.sendMessage(from, { text: 'Error enviando audio 😔' });
      } finally {
        fsExtra.removeSync(filePath);
      }
    });

  } catch(e){ 
    console.log('Error #ytaudio:', e);
    await sock.sendMessage(from, { text: 'Ocurrió un error descargando el audio 😔' });
  }
}


          if(text.startsWith('#ytvideo')){
            try {
              const query = text.replace('#ytvideo','').trim();
              const r = await yts(query);
              const video = r.videos.length > 0 ? r.videos[0] : null;
              if(!video) return await sock.sendMessage(from, { text: 'No se encontró video 😔' });
              await sock.sendMessage(from, { text: `Video link: ${video.url}` });
            } catch(e){ 
              console.log('Error ytvideo:', e);
              await sock.sendMessage(from, { text: 'Ocurrió un error buscando video 😔' });
            }
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
