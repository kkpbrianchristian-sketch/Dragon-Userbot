const { 
  default: makeWASocket, 
  DisconnectReason, 
  initAuthCreds, 
  BufferJSON, 
  proto,
  downloadContentFromMessage 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const pino = require("pino");
const fetch = require("node-fetch");
const FormData = require("form-data");

const MONGO_URI = process.env.DATABASE_URL;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// Adapter lengkap MongoDB untuk menyimpan creds dan kunci enkripsi (keys)
async function useMongoDBAuthState(collection) {
  const writeData = async (data, id) => {
    try {
      await collection.updateOne(
        { _id: id },
        { $set: { data: JSON.stringify(data, BufferJSON.replacer) } },
        { upsert: true }
      );
    } catch (err) {
      console.error("[MONGO WRITE ERROR]:", err.message);
    }
  };

  const readData = async (id) => {
    try {
      const res = await collection.findOne({ _id: id });
      if (!res?.data) return null;
      return JSON.parse(res.data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id });
    } catch {}
  };

  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, "creds")
  };
}

// Unduh file/media langsung dari stream Baileys
async function getMediaBuffer(mediaObj, type) {
  const stream = await downloadContentFromMessage(mediaObj, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}

// Kirim dokumen ke API Telegram
async function sendToTelegram(buffer, filename, caption) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.error("[TELEGRAM ERROR]: TG_BOT_TOKEN atau TG_CHAT_ID belum diisi di Heroku!");
    return false;
  }

  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("document", buffer, { filename: filename || "dokumen.bin" });
  if (caption) form.append("caption", caption);

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: form
    });
    const result = await res.json();
    return result.ok;
  } catch (err) {
    console.error("[TELEGRAM UPLOAD ERROR]:", err.message);
    return false;
  }
}

async function startBot() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const collection = client.db("dragonbot").collection("wa_session");

  const { state, saveCreds } = await useMongoDBAuthState(collection);

  const sock = makeWASocket({
    logger: pino({ level: "warn" }),
    auth: state
  });

  sock.ev.on("creds.update", saveCreds);

  if (!sock.authState.creds.registered && PHONE_NUMBER) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log(`\n========================================`);
      console.log(`>>> KODE PAIRING WA ANDA: ${code} <<<`);
      console.log(`========================================\n`);
    }, 4000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        startBot();
      } else {
        console.log("Koneksi ditutup permanen atau di-logout dari HP.");
      }
    } else if (connection === "open") {
      console.log("WhatsApp bot siap! Kirim atau balas file dengan .save");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      if (!m.message) continue;

      let rawMsg = m.message;
      if (rawMsg.deviceSentMessage?.message) rawMsg = rawMsg.deviceSentMessage.message;
      if (rawMsg.ephemeralMessage?.message) rawMsg = rawMsg.ephemeralMessage.message;

      const bodyText = (
        rawMsg.conversation ||
        rawMsg.extendedTextMessage?.text ||
        rawMsg.imageMessage?.caption ||
        rawMsg.documentMessage?.caption ||
        rawMsg.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        ""
      ).trim().toLowerCase();

      // Log pemantau setiap kali ada chat masuk/keluar
      console.log(`[LOG CHAT] fromMe: ${m.key.fromMe} | Teks: "${bodyText}" | Target: ${m.key.remoteJid}`);

      if (bodyText !== ".save") continue;

      console.log("[USERBOT]: Perintah .save terdeteksi! Memeriksa lampiran...");

      const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
      let targetMedia = null;
      let mediaType = "";
      let fileName = "file_wa";

      // Kasus 1: Me-reply chat yang berisi dokumen/media
      if (quoted) {
        let qMsg = quoted;
        if (qMsg.ephemeralMessage?.message) qMsg = qMsg.ephemeralMessage.message;

        const doc = qMsg.documentMessage || qMsg.documentWithCaptionMessage?.message?.documentMessage;
        if (doc) {
          targetMedia = doc;
          mediaType = "document";
          fileName = doc.fileName || "dokumen.pdf";
        } else if (qMsg.imageMessage) {
          targetMedia = qMsg.imageMessage;
          mediaType = "image";
          fileName = `foto_${Date.now()}.jpg`;
        } else if (qMsg.videoMessage) {
          targetMedia = qMsg.videoMessage;
          mediaType = "video";
          fileName = `video_${Date.now()}.mp4`;
        }
      } 
      // Kasus 2: Kirim dokumen langsung dengan caption .save
      else {
        const doc = rawMsg.documentMessage || rawMsg.documentWithCaptionMessage?.message?.documentMessage;
        if (doc) {
          targetMedia = doc;
          mediaType = "document";
          fileName = doc.fileName || "dokumen.pdf";
        } else if (rawMsg.imageMessage) {
          targetMedia = rawMsg.imageMessage;
          mediaType = "image";
          fileName = `foto_${Date.now()}.jpg`;
        } else if (rawMsg.videoMessage) {
          targetMedia = rawMsg.videoMessage;
          mediaType = "video";
          fileName = `video_${Date.now()}.mp4`;
        }
      }

      if (!targetMedia) {
        await sock.sendMessage(m.key.remoteJid, { text: "Kutip (reply) pesan file/gambar lalu ketik .save" });
        continue;
      }

      try {
        console.log(`[USERBOT]: Mengunduh ${fileName} (${mediaType})...`);
        const buffer = await getMediaBuffer(targetMedia, mediaType);

        console.log(`[USERBOT]: Mengirim ${fileName} ke Telegram...`);
        const caption = `*File dari WA:*\n${fileName}\n*Pengirim:* ${m.key.remoteJid}`;
        const sukses = await sendToTelegram(buffer, fileName, caption);

        if (sukses) {
          await sock.sendMessage(m.key.remoteJid, { text: `Berhasil diteruskan ke Telegram: ${fileName}` });
          console.log("[USERBOT]: Selesai diteruskan ke Telegram!");
        } else {
          await sock.sendMessage(m.key.remoteJid, { text: "Gagal kirim ke Telegram, cek Config Vars Heroku." });
        }
      } catch (err) {
        console.error("[USERBOT ERROR UNDUH/KIRIM]:", err);
      }
    }
  });
}

startBot();
