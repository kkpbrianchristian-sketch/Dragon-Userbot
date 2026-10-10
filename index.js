const { 
  default: makeWASocket, 
  DisconnectReason, 
  initAuthCreds, 
  BufferJSON, 
  proto,
  downloadContentFromMessage 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pino = require("pino");
const fetch = require("node-fetch");
const FormData = require("form-data");

const MONGO_URI = process.env.DATABASE_URL;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

async function useMongoDBAuthState(collection) {
  const writeData = async (data, id) => {
    try {
      await collection.updateOne(
        { _id: id },
        { $set: { data: JSON.stringify(data, BufferJSON.replacer) } },
        { upsert: true }
      );
    } catch (err) {}
  };

  const readData = async (id) => {
    try {
      const res = await collection.findOne({ _id: id });
      if (!res?.data) return null;
      return JSON.parse(res.data, BufferJSON.reviver);
    } catch { return null; }
  };

  const removeData = async (id) => {
    try { await collection.deleteOne({ _id: id }); } catch {}
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

async function getMediaBuffer(mediaObj, type) {
  const stream = await downloadContentFromMessage(mediaObj, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}

async function sendToTelegram(buffer, filename, caption) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("document", buffer, { filename: filename || "dokumen.bin" });
  if (caption) form.append("caption", caption);

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`, {
      method: "POST", body: form
    });
    const result = await res.json();
    return result.ok;
  } catch { return false; }
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

  const botStartTime = Math.floor(Date.now() / 1000);

  if (!sock.authState.creds.registered && PHONE_NUMBER) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log(`\n>>> KODE PAIRING WA: ${code} <<<\n`);
      } catch (e) {
        console.log("Gagal request pairing code:", e.message);
      }
    }, 4000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("Hore! WA Bot sudah bangun!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const m of messages) {
      if (!m.message) continue;

      const msgTime = Number(m.messageTimestamp);
      if (msgTime < botStartTime) continue;

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
      ).trim();

      const lowerText = bodyText.toLowerCase();

      // FITUR 1: Gemini AI dengan Sistem Auto-Turun Kasta (Waterfall)
      if (lowerText.startsWith(".ai ") || lowerText.startsWith(".gemini ")) {
        if (!m.key.fromMe) continue;

        const query = bodyText.replace(/^(\.ai|\.gemini)\s+/i, "").trim();
        if (!query) return;
        if (!genAI) return;

        // Daftar urutan kasta dari yang paling pintar/terbaru sampai ke ban serep
        const modelHierarchy = [
          "gemini-3.8-flash",
          "gemini-3.7-flash",
          "gemini-3.6-flash",
          "gemini-3.5-flash",
          "gemini-3.5-flash-lite"
        ];

        let success = false;

        // Loop otomatis mencoba model satu per satu
        for (const modelName of modelHierarchy) {
          try {
            console.log(`[GEMINI] Mencoba model: ${modelName}`);
            const model = genAI.getGenerativeModel({ 
              model: modelName,
              tools: [{ googleSearch: {} }] 
            });
            const result = await model.generateContent(query);
            await sock.sendMessage(m.key.remoteJid, { text: result.response.text() }, { quoted: m });
            
            success = true; // Kalau berhasil, ubah status
            break; // Stop perulangan, tidak perlu coba model di bawahnya lagi
            
          } catch (err) {
            console.log(`[GEMINI ERROR] ${modelName} gagal: ${err.message}. Turun kasta...`);
            // Kalau error/limit, loop akan otomatis lanjut ke modelName berikutnya
          }
        }

        // Kalau semua model dari 3.8 sampai 3.5 Lite gagal total
        if (!success) {
          await sock.sendMessage(m.key.remoteJid, { text: "Duh, semua versi Gemini lagi capek atau limit kuotanya habis total hari ini." }, { quoted: m });
        }
        continue;
      }

      // FITUR 2: Simpan File ke Telegram (.save)
      if (lowerText === ".save" && m.key.fromMe) {
        const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
        let targetMedia = null;
        let mediaType = "";
        let fileName = "file_wa";
        let targetMsg = quoted ? (quoted.ephemeralMessage?.message || quoted) : rawMsg;

        const doc = targetMsg.documentMessage || targetMsg.documentWithCaptionMessage?.message?.documentMessage;
        if (doc) {
          targetMedia = doc; mediaType = "document"; fileName = doc.fileName || "dokumen.pdf";
        } else if (targetMsg.imageMessage) {
          targetMedia = targetMsg.imageMessage; mediaType = "image"; fileName = `foto_${Date.now()}.jpg`;
        } else if (targetMsg.videoMessage) {
          targetMedia = targetMsg.videoMessage; mediaType = "video"; fileName = `video_${Date.now()}.mp4`;
        }

        if (!targetMedia) {
          await sock.sendMessage(m.key.remoteJid, { text: "Eh, file-nya mana? Reply dulu pesannya ya!" });
          continue;
        }

        try {
          const buffer = await getMediaBuffer(targetMedia, mediaType);
          const caption = `*Dapat dari WA nih:*\n${fileName}\n*Dari:* ${m.key.remoteJid}`;
          const sukses = await sendToTelegram(buffer, fileName, caption);

          if (sukses) {
            await sock.sendMessage(m.key.remoteJid, { text: `Yeay! ${fileName} udah masuk ke Telegram!` });
          }
        } catch (err) {
          console.error("[ERROR SAVE]:", err);
        }
      }
    }
  });
}

startBot();
