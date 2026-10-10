import os
import aiohttp
from pyrogram import Client, filters
from pyrogram.types import Message

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

@Client.on_message(filters.command(["ai", "gemini"], prefixes=[".", "!"]) & filters.me)
async def gemini_telegram(client: Client, message: Message):
    if len(message.command) < 2:
        await message.edit_text("❌ Eh, lupa nanya apa? Ketik pertanyaannya ya, misal: `.ai 1+1 berapa?`")
        return

    query = message.text.split(maxsplit=1)[1]

    if not GEMINI_API_KEY:
        await message.edit_text("❌ Kunci kunci GEMINI_API_KEY belum dipasang di perut Heroku!")
        return

    await message.edit_text("🧠 *Tunggu ya, lagi mikir keras...*")

    payload = {"contents": [{"parts": [{"text": query}]}]}
    
    # Abang "Pro" maju duluan, Adik "Flash" nunggu giliran
    models = ["gemini-3.1-pro", "gemini-3.8-flash"]

    try:
        async with aiohttp.ClientSession() as session:
            for model_name in models:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={GEMINI_API_KEY}"
                
                async with session.post(url, json=payload) as response:
                    if response.status == 200:
                        data = await response.json()
                        reply_text = data["candidates"][0]["content"]["parts"][0]["text"]
                        await message.edit_text(reply_text)
                        break  # Hore berhasil jawab! Keluar barisan.
                    
                    elif response.status == 429:
                        # Waduh Abang capek (limit), kasih tahu sebentar trus Adik maju.
                        if model_name == "gemini-3.1-pro":
                            await message.edit_text("⏳ *Duh, limit 3.1 Pro habis! Ganti pakai 3.8 Flash ya...*")
                        continue 
                    
                    else:
                        err_data = await response.text()
                        await message.edit_text(f"❌ Yah gagal nangkap bola {model_name}:\n`{err_data}`")
                        break
    except Exception as e:
        await message.edit_text(f"❌ Aduh ada yang rusak nih:\n`{str(e)}`")
