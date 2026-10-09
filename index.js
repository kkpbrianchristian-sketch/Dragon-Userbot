const { 
  default: makeWASocket, 
  DisconnectReason, 
  initAuthCreds, 
  BufferJSON 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const pino = require("pino");

const MONGO_URI = process.env.DATABASE_URL;
const PHONE_NUMBER = process.env.PHONE_NUMBER;

async function startBot() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const collection = client.db("dragonbot").collection("wa_session");

  const savedSession = await collection.findOne({ _id: "session" });
  let creds = savedSession ? JSON.parse(savedSession.data, BufferJSON.reviver) : initAuthCreds();

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: {
      creds,
      keys: {
        get: (type, ids) => ({}),
        set: () => {}
      }
    }
  });

  sock.ev.on("creds.update", async () => {
    await collection.updateOne(
      { _id: "session" },
      { $set: { data: JSON.stringify(creds, BufferJSON.replacer) } },
      { upsert: true }
    );
  });

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
        console.log("Koneksi terputus permanen / akun di-logout dari HP.");
      }
    } else if (connection === "open") {
      console.log("WhatsApp bot berhasil terhubung!");
    }
  });

  // Tangani pesan masuk / keluar
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    if (!m || !m.message) return;

    // Filter khusus: hanya proses chat yang dikirim oleh nomor kamu sendiri
    if (!m.key.fromMe) return;

    // Buka pembungkus pesan teks (mendukung pesan biasa, mention, dan disappearing messages)
    const rawMsg = m.message.ephemeralMessage?.message || m.message;
    const body = 
      rawMsg.conversation || 
      rawMsg.extendedTextMessage?.text || 
      "";

    const cleanBody = body.trim().toLowerCase();

    // Log ke terminal Heroku untuk memastikan ketikan kamu tertangkap sistem
    if (cleanBody.startsWith(".")) {
      console.log(`[USERBOT COMMAND DETECTED]: ${cleanBody} di chat: ${m.key.remoteJid}`);
    }

    if (cleanBody === ".ping") {
      try {
        // Kirim tanpa { quoted: m } agar tidak bentrok dengan stanza fromMe
        await sock.sendMessage(m.key.remoteJid, { text: "Pong dari Heroku!" });
        console.log("[USERBOT]: Balasan Pong berhasil terkirim!");
      } catch (err) {
        console.error("[USERBOT ERROR saat kirim pesan]:", err);
      }
    }
  });
}

startBot();
