const { 
  default: makeWASocket, 
  DisconnectReason, 
  initAuthCreds, 
  BufferJSON, 
  downloadMediaMessage 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const pino = require("pino");
const fetch = require("node-fetch");
const FormData = require("form-data");

const MONGO_URI = process.env.DATABASE_URL;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendToTelegram(buffer, filename, caption) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.error("[ERROR]: TG_BOT_TOKEN atau TG_CHAT_ID belum diisi di Config Vars!");
    return false;
  }

  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("document", buffer, { filename: filename || "file_wa.bin" });
  if (caption) form.append("caption", caption);

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: form
    });
    const result = await res.json();
    return result.ok;
  } catch (err) {
    console.error("[TELEGRAM UPLOAD ERROR]:", err);
    return false;
  }
}

async function startBot() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const collection = client.db("dragonbot").collection("wa_session");

  const savedSession = await collection.findOne({ _id: "session_creds" });
  let creds = savedSession ? JSON.parse(savedSession.data, BufferJSON.reviver) : initAuthCreds();

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: {
      creds,
      keys: {
        get: () => ({}),
        set: () => {}
      }
    }
  });

  sock.ev.on("creds.update", async () => {
    await collection.updateOne(
      { _id: "session_creds" },
      { $set: { data: JSON.stringify(creds, BufferJSON.replacer) } },
      { upsert: true }
    );
  });

  if (!sock.authState.creds.registered && PHONE_NUMBER) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log(`\n>>> KODE PAIRING WA ANDA: ${code} <<<\n`);
    }, 4000);
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("WhatsApp bot siap menerima perintah .save!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      if (!m.message) continue;

      // Bongkar pesan jika terbungkus sinkronisasi MD atau disappearing
      let rawMsg = m.message;
      if (rawMsg.deviceSentMessage?.message) rawMsg = rawMsg.deviceSentMessage.message;
      if (rawMsg.ephemeralMessage?.message) rawMsg = rawMsg.ephemeralMessage.message;

      // Cek teks perintah
      const text = (
        rawMsg.conversation ||
        rawMsg.extendedTextMessage?.text ||
        rawMsg.imageMessage?.caption ||
        rawMsg.documentMessage?.caption ||
        rawMsg.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        ""
      ).trim().toLowerCase();

      if (text !== ".save") continue;

      const quoted = rawMsg.extendedTextMessage?.contextInfo?.quotedMessage;
      let targetMediaMsg = null;
      let fileName = "file_wa";

      // Kasus 1: Me-reply pesan yang berisi file/media
      if (quoted) {
        let qMsg = quoted;
        if (qMsg.ephemeralMessage?.message) qMsg = qMsg.ephemeralMessage.message;
        
        const doc = qMsg.documentMessage || qMsg.documentWithCaptionMessage?.message?.documentMessage;
        if (doc) {
          fileName = doc.fileName || "dokumen.pdf";
          targetMediaMsg = { message: qMsg };
        } else if (qMsg.imageMessage) {
          fileName = `foto_${Date.now()}.jpg`;
          targetMediaMsg = { message: qMsg };
        } else if (qMsg.videoMessage) {
          fileName = `video_${Date.now()}.mp4`;
          targetMediaMsg = { message: qMsg };
        }
      } 
      // Kasus 2: Mengirim file langsung dengan caption .save
      else {
        const doc = rawMsg.documentMessage || rawMsg.documentWithCaptionMessage?.message?.documentMessage;
        if (doc) {
          fileName = doc.fileName || "dokumen.pdf";
          targetMediaMsg = { message: rawMsg };
        } else if (rawMsg.imageMessage) {
          fileName = `foto_${Date.now()}.jpg`;
          targetMediaMsg = { message: rawMsg };
        } else if (rawMsg.videoMessage) {
          fileName = `video_${Date.now()}.mp4`;
          targetMediaMsg = { message: rawMsg };
        }
      }

      if (!targetMediaMsg) {
        await sock.sendMessage(m.key.remoteJid, { text: "Kutip (reply) pesan yang berisi file/gambar, lalu ketik .save" });
        continue;
      }

      try {
        console.log(`[USERBOT]: Mengunduh "${fileName}" untuk dikirim ke Telegram...`);
        const buffer = await downloadMediaMessage(
          targetMediaMsg,
          "buffer",
          {},
          { 
            logger: pino({ level: "silent" }),
            reuploadRequest: sock.updateMediaMessage 
          }
        );

        const caption = `📁 *Saved from WhatsApp*\n*File:* ${fileName}\n*Pengirim:* ${m.key.remoteJid}`;
        const sent = await sendToTelegram(buffer, fileName, caption);

        if (sent) {
          await sock.sendMessage(m.key.remoteJid, { text: `Tersimpan ke Telegram: ${fileName}` });
        } else {
          await sock.sendMessage(m.key.remoteJid, { text: "Gagal upload ke Telegram. Periksa token bot / chat ID!" });
        }
      } catch (err) {
        console.error("[DOWNLOAD ERROR]:", err);
      }
    }
  });
}

startBot();
