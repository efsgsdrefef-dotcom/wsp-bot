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

// --- IA BÁSICA OFFLINE ---
const respuestasIA = [
  { patrones: ['hola', 'buenas'], respuesta: '¡Hola @! 😎🔥' },
  { patrones: ['gracias', 'muchas gracias'], respuesta: 'De nada @ 😉' },
  { patrones: ['cómo estás', 'como estas'], respuesta: 'Estoy bien @, ¿y tú? 😁' },
  { patrones: ['buenas noches'], respuesta: '¡Buenas noches @! 🌙✨' },
  { patrones: ['adiós', 'nos vemos'], respuesta: 'Nos vemos @ 👋' }
];

function responderIA(text, from, participants){
  text = text.toLowerCase();
  for(const item of respuestasIA){
    for(const pat of item.patrones){
      if(text.includes(pat)){
        if(participants && participants.length > 0){
          const jid = participants.find(p => p.id === from)?.id || from;
          return item.respuesta.replace('@', `@${jid.split('@')[0]}`);
        } else {
          return item.respuesta.replace('@', '');
        }
      }
    }
  }
  return null;
}

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
    if(events['connection.update']){
      const { connection, lastDisconnect, qr } = events['connection.update'];

      if(qr){
        latestQR = await QRCode.toDataURL(qr);
        console.log('QR generado! Abre /qr en tu navegador para escanearlo.');
      }

      if(connection === 'close'){
        if((lastDisconnect?.error?.output?.statusCode) !== DisconnectReason.loggedOut){
          console.log('Reconectando...');
          startSock();
        } else {
          console.log('Connection closed. You are logged out.');
        }
      }
    }

    if(events['creds.update']) await saveCreds();

    if(events['messages.upsert']){
      const upsert = events['messages.upsert'];
      for(const msg of upsert.messages){
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || from;
        const text = msg.message?.conversation?.toLowerCase()
                     || msg.message?.extendedTextMessage?.text?.toLowerCase();

        if(!text) continue;

        // --- COMANDOS ---

        // STICKER desde URL o imagen enviada
        if(text.startsWith('#sticker')){
          try {
            let buffer;
            if(msg.message?.imageMessage){
              const media = await sock.downloadMediaMessage({ message: { imageMessage: msg.message.imageMessage } });
              buffer = Buffer.from(media);
            } else {
              const mediaUrl = text.split(' ')[1];
              if(!mediaUrl) return await sock.sendMessage(from, { text: 'Debes enviar una URL de imagen.' });
              const image = await Jimp.read(mediaUrl);
              buffer = await image.getBufferAsync(Jimp.MIME_PNG);
            }
            await sock.sendMessage(from, { sticker: buffer });
          } catch(e){
            console.log('Error sticker:', e);
            await sock.sendMessage(from, { text: 'Error al crear sticker.' });
          }
        }

        // YTAUDIO seguro
        if(text.startsWith('#ytaudio')){
          try {
            const query = text.replace('#ytaudio','').trim();
            const r = await yts(query);
            const video = r.videos.length > 0 ? r.videos[0] : null;
            if(!video) return await sock.sendMessage(from, { text: 'No se encontró audio 😔' });

            const filePath = `audio.mp3`;
            const stream = ytdl(video.url, { filter: 'audioonly', highWaterMark: 1<<25 });
            const writeStream = fs.createWriteStream(filePath);

            const timeout = setTimeout(() => {
              stream.destroy();
              if(fs.existsSync(filePath)) fsExtra.removeSync(filePath);
              sock.sendMessage(from, { text: 'La descarga tardó demasiado y fue cancelada ⏱️' });
            }, 60000);

            stream.on('error', async (err) => {
              console.log('Error en ytdl stream:', err);
              if(fs.existsSync(filePath)) fsExtra.removeSync(filePath);
              await sock.sendMessage(from, { text: 'Error descargando el audio 😔' });
            });

            stream.pipe(writeStream);
            writeStream.on('finish', async () => {
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

        // YTVIDEO
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

        // --- RESPUESTAS IA BÁSICA ---
        let participants = null;
        if(from.endsWith('@g.us')){
          const group = await sock.groupMetadata(from);
          participants = group.participants;
        }
        const respuesta = responderIA(text, from, participants);
        if(respuesta) await sock.sendMessage(from, { text: respuesta });

        // Anti-link simple
        if(text.includes('link')){
          await sock.sendMessage(from, { text: 'Anti-link activo 🚫' });
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
