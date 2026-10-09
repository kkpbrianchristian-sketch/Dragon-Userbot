const { 
  default: makeWASocket, 
  DisconnectReason, 
  initAuthCreds, 
  BufferJSON 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");
const pino = require("pino");

const MONGO_URI = process.env.DATABASE_URL;
const PHONE_NUMBER = process.env.PHONE_NUMBER; // Contoh: 6281234567890

async function startBot() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const collection = client.db("dragonbot").collection("wa_session");

  // Ambil sesi lama dari MongoDB kalau sudah pernah login
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

  // Simpan data login otomatis ke MongoDB setiap ada pembaruan token
  sock.ev.on("creds.update", async () => {
    await collection.updateOne(
      { _id: "session" },
      { $set: { data: JSON.stringify(creds, BufferJSON.replacer) } },
      { upsert: true }
    );
  });

  // Tampilkan kode pairing jika akun belum terdaftar
  if (!sock.authState.creds.registered && PHONE_NUMBER) {
    setTimeout(async () => {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log(`\n========================================`);
      console.log(`>>> KODE PAIRING WA ANDA: ${code} <<<`);
      console.log(`========================================\n`);
    }, 4000);
  }

  // Monitor status koneksi
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

  // Tangani pesan masuk (khusus chat dari diri sendiri)
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const m = messages[0];
    
    // Abaikan jika bukan pesan teks atau jika pesan BUKAN dikirim oleh kamu sendiri
    if (!m.message || !m.key.fromMe) return;

    const body = 
      m.message.conversation || 
      m.message.extendedTextMessage?.text || 
      "";

    // Perintah .ping
    if (body.trim() === ".ping") {
      await sock.sendMessage(
        m.key.remoteJid, 
        { text: "Pong dari Heroku!" }, 
        { quoted: m }
      );
    }
  });
}

startBot();
