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
      console.log("WhatsApp bot berhasil terhubung!");
    }
  });

  // Tangani semua event pesan masuk maupun keluar
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      if (!m.message) continue;

      // Cetak ringkasan pesan ke terminal Heroku untuk debugging
      console.log(`[EVENT MASUK] fromMe: ${m.key.fromMe} | Type: ${type} | Jid: ${m.key.remoteJid}`);

      // Ambil teks dari berbagai struktur pembungkus pesan
      const msg = m.message.deviceSentMessage?.message || m.message.ephemeralMessage?.message || m.message;
      const text = msg.conversation || msg.extendedTextMessage?.text || "";

      console.log(`[TEKS TERDETEKSI]: "${text}"`);

      // Cek perintah jika pesan berasal dari akun Anda sendiri
      if (m.key.fromMe && text.trim().toLowerCase() === ".ping") {
        try {
          console.log("[USERBOT]: Mengirim balasan Pong...");
          await sock.sendMessage(m.key.remoteJid, { text: "Pong dari Heroku!" });
          console.log("[USERBOT]: Balasan berhasil terkirim!");
        } catch (err) {
          console.error("[USERBOT ERROR]: Gagal kirim pesan:", err);
        }
      }
    }
  });
}

startBot();
