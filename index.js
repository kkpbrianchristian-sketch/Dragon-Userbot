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

// Helper untuk membongkar segala jenis pembungkus pesan WhatsApp
function extractMessageText(m) {
  if (!m || !m.message) return "";
  let msg = m.message;

  // 1. Bongkar sinkronisasi pesan dari HP utama (Multi-Device sync)
  if (msg.deviceSentMessage?.message) {
    msg = msg.deviceSentMessage.message;
  }

  // 2. Bongkar disappearing messages (pesan sementara)
  if (msg.ephemeralMessage?.message) {
    msg = msg.ephemeralMessage.message;
  }

  // 3. Bongkar view-once jika ada
  if (msg.viewOnceMessage?.message) {
    msg = msg.viewOnceMessage.message;
  }
  if (msg.viewOnceMessageV2?.message) {
    msg = msg.viewOnceMessageV2.message;
  }

  // Ambil teks utama
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  );
}

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

  // Tangani semua pesan masuk / tersinkronisasi
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      if (!m || !m.message) continue;

      // Filter: Hanya proses pesan yang dikirim oleh nomor kamu sendiri
      if (!m.key.fromMe) continue;

      const body = extractMessageText(m);
      const cleanBody = body.trim().toLowerCase();

      // Log pelacak jika ada pesan keluar dari nomor kamu
      if (cleanBody) {
        console.log(`[OUTGOING CHAT]: "${cleanBody}" | Target: ${m.key.remoteJid}`);
      }

      // Perintah .ping
      if (cleanBody === ".ping") {
        try {
          console.log("[USERBOT]: Perintah .ping terdeteksi, membalas...");
          await sock.sendMessage(m.key.remoteJid, { text: "Pong dari Heroku!" });
          console.log("[USERBOT]: Balasan berhasil terkirim!");
        } catch (err) {
          console.error("[USERBOT ERROR kirim pesan]:", err);
        }
      }
    }
  });
}

startBot();
