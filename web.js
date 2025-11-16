import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
dotenv.config();
import { handleOAuthCallback, client, voiceStates } from './bot.js';


const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;

// 認証ページ
app.get('/auth/', (req, res) => {
  res.send(`
  <!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>さくら雑談王国認証ページ</title>
<!-- Discord風フォント読み込み -->
<link href="https://fonts.googleapis.com/css2?family=gg-sans:wght@400;700&display=swap" rel="stylesheet">
<style>
  body {
    font-family: 'gg-sans', 'Segoe UI', sans-serif;
    background: #262626; /* 濃い背景 */
    color: #FFFFFF;       /* 文字白 */
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
  }

  h1 {
    text-align: center;
    color: #FFFFFF;
  }

  a.button {
    display: inline-block;
    padding: 15px 25px;
    margin-top: 20px;
    font-size: 18px;
    font-weight: bold;
    color: #FFFFFF;
    background: #60B6BF;
    border-radius: 0;           /* 四角 */
    border: 2px solid #FFFFFF;  /* 白ボーダー */
    text-decoration: none;
    box-shadow: 4px 4px 0 #FFFFFF; /* 右下に白影 */
    transition: 0.2s;
  }

  a.button:hover {
    background: #BF73A4;
    box-shadow: 4px 4px 0 #60B6BF; /* ホバー時に反転 */
  }

  .container {
    text-align: center;
    max-width: 400px;
  }
</style>
</head>
<body>
  <div class="container">
    <h1>さくら雑談王国認証ページへようこそ</h1>
    <a href="https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify" class="button">
      Discordで認証
    </a>
  </div>
</body>
</html>

  `);
});

// ルート: bot稼働中 + iframeでGASステータス読み込み
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Bot稼働状況</title>
      <style>
        body {
          font-family: 'Arial', sans-serif;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          background: #f0f2f5;
        }
        header {
          width: 100%;
          padding: 20px;
          text-align: center;
          background: #5865F2;
          color: #fff;
          font-size: 1.5rem;
        }
        main {
          margin-top: 20px;
          width: 90%;
          max-width: 800px;
        }
        iframe {
          width: 100%;
          border: none;
          border-radius: 8px;
          box-shadow: 0 0 10px rgba(0,0,0,0.2);
        }
      </style>
    </head>
    <body>
      <header>Bot稼働中🚀</header>
      <main>
        <h2>ライブステータス</h2>
        <iframe id="statusFrame" src="https://script.google.com/macros/s/AKfycbwbh9oEmOWhNN9k_t86JmpKJZizPD_Ty4nSQxhusI1dJluwruXZET62nPgNupWVp9_p0A/exec" scrolling="no"></iframe>
        <h3>利用規約等</h3>
        <button onclick="location.href='https://kiyaku.bot.sakurahp.f5.si/'">利用規約&プライバリシーポリシーを見る</button>
      </main>
      <script>
        // GAS側からpostMessageで高さを受け取る
        const iframe = document.getElementById('statusFrame');
        window.addEventListener('message', (e) => {
          if (e.data.height) {
            iframe.style.height = e.data.height + 'px';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// コールバック
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    const html = await handleOAuthCallback({ code, ip });
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('認証エラー');
  }
});

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;

// JST 時刻
const nowJST = () =>
  new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

app.get("/api", async (req, res) => {
  try {
    // --- ギルド情報（REST） ---
    const guildRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
    });
    if (!guildRes.ok) throw new Error(`Guild fetch failed: ${guildRes.status}`);
    const guildData = await guildRes.json();

    // --- オーナー情報 ---
    const ownerRes = await fetch(
      `https://discord.com/api/v10/users/1208358513580052500`,
      { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } }
    );
    if (!ownerRes.ok) throw new Error(`Owner fetch failed: ${ownerRes.status}`);
    const ownerData = await ownerRes.json();

    // --- VC 状態（Gateway / client） ---
    const vcMap = voiceStates.get(GUILD_ID) || new Map();

    // チャンネルごとにユーザーIDをまとめる
    const voice_detail = {};
    vcMap.forEach((channelId, userId) => {
      if (!voice_detail[channelId]) voice_detail[channelId] = [];
      voice_detail[channelId].push(userId);
    });

    res.json({
      status: 200,
      timestamp: nowJST(),
      guild: {
        id: guildData.id,
        name: guildData.name,
        owner: guildData.owner_id,
        icon: guildData.icon
          ? `https://cdn.discordapp.com/icons/${guildData.id}/${guildData.icon}.png`
          : null,
        member: guildData.approximate_member_count || 0,
        online: guildData.approximate_presence_count || 0,
        voice: vcMap.size,
        voice_detail
      },
      owner: {
        id: ownerData.id,
        name: ownerData.username,
        icon: ownerData.avatar
          ? `https://cdn.discordapp.com/avatars/${ownerData.id}/${ownerData.avatar}.png`
          : null
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: 500,
      error: err.message
    });
  }
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
