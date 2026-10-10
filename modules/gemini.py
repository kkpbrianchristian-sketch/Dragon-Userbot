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
        await message.edit_text("❌ Kunci GEMINI_API_KEY belum dipasang di perut Heroku!")
        return

    await message.edit_text("🧠 *Tunggu ya, lagi mikir keras...*")

    # Payload polosan tanpa embel-embel alat pencarian
    payload = {
        "contents": [{"parts": [{"text": query}]}]
    }
    
    models = [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite"
    ]

    try:
        async with aiohttp.ClientSession() as session:
            for model_name in models:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={GEMINI_API_KEY}"
                
                async with session.post(url, json=payload) as response:
                    if response.status == 200:
                        data = await response.json()
                        reply_text = data["candidates"][0]["content"]["parts"][0]["text"]
                        
                        if model_name != "gemini-3.8-flash":
                            reply_text = f"*(Dialihkan ke {model_name} karena limit)*\n\n" + reply_text
                            
                        await message.edit_text(reply_text)
                        return
                    
                    # Tambahan angka 400 dan 403 untuk menangkap penolakan fitur
                    elif response.status in [429, 404, 403, 400]:
                        continue 
                    else:
                        err_data = await response.text()
                        await message.edit_text(f"❌ Error API {model_name} ({response.status}):\n`{err_data}`")
                        return

            await message.edit_text("❌ Waduh, semua kasta Gemini lagi error atau limit hari ini!")
            
    except Exception as e:
        await message.edit_text(f"❌ Aduh ada yang rusak nih:\n`{str(e)}`")
