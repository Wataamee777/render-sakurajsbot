import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from "cookie-parser";
import dotenv from 'dotenv';
dotenv.config();
import { supabase } from "./db.js";
import { shardState } from "./index.js";
import { handleOAuthCallback, client, voiceStates } from './bot.js';
import cors from 'cors';

const app = express();
app.use(cors()); // CORS回避
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cookieParser());
const PORT = process.env.PORT || 3000;

const DISCORD_API = "https://discord.com/api";

// ===== OAuth2 URL =====
function adminOAuthURL() {
  return `https://discord.com/oauth2/authorize?` +
    new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: 'https://bot.sakurahp.f5.si/admins/callback',
      response_type: "code",
      scope: "identify",
    });
}

// ===== Discord user取得 =====
async function getDiscordUser(code) {
  const token = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: 'https://bot.sakurahp.f5.si/admins/callback',
    }),
  }).then(r => r.json());

  return fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  }).then(r => r.json());
}

// ===== 管理者チェック =====
async function requireAdmin(req, res, next) {
  const adminId = req.cookies.admin;
  if (!adminId) return res.redirect(adminOAuthURL());

  const { data } = await supabase
    .from("admins")
    .select("discord_id")
    .eq("discord_id", adminId)
    .single();

  if (!data) return res.sendStatus(401);
  next();
}

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

// ===== 管理画面 =====
app.get("/admins", requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from("warned_users")
    .select("*")
    .order("updated_at", { ascending: false });

  const rows = (data || []).map(u => `
    <tr>
      <td>${u.discord_id}</td>
      <td>${u.reason}</td>
      <td>${new Date(u.updated_at).toLocaleString()}</td>
    </tr>
  `).join("");

  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>運営管理 - 危険ユーザー</title>
<style>
body { font-family: sans-serif; background:#f5f5f5; padding:20px }
h1 { margin-bottom:10px }
table { border-collapse: collapse; width:100%; background:#fff }
th, td { border:1px solid #ccc; padding:8px }
th { background:#eee }
form { margin-top:20px; background:#fff; padding:15px }
input, textarea, button { width:100%; margin-top:5px; padding:8px }
button { margin-top:10px }
</style>
</head>
<body>

<h1>⚠ 危険ユーザー一覧</h1>

<table>
<tr>
  <th>Discord ID</th>
  <th>理由</th>
  <th>更新日時</th>
</tr>
${rows || "<tr><td colspan='3'>まだ登録なし</td></tr>"}
</table>

<h2>➕ 追加</h2>
<form method="POST" action="/admins/add">
  <label>Discord ID</label>
  <input name="targetId" required>

  <label>理由</label>
  <textarea name="reason" required></textarea>

  <button type="submit">追加する</button>
</form>

</body>
</html>
  `);
});

// ===== callback =====
app.get("/admins/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.sendStatus(401);

  const user = await getDiscordUser(code);

  const { data } = await supabase
    .from("admins")
    .select("discord_id")
    .eq("discord_id", user.id)
    .single();

  if (!data) return res.sendStatus(401);

  res.cookie("admin", user.id, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24,
  });

  res.redirect("/admins");
});

// ===== 追加処理 =====
app.post("/admins/add", requireAdmin, async (req, res) => {
  const { targetId, reason } = req.body;

  await supabase.from("warned_users").upsert({
    discord_id: targetId,
    reason,
    updated_at: new Date(),
  });

  res.redirect("/admins");
});

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;

// JST 時刻
const nowJST = () =>
  new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

app.get("/api", async (req, res) => {
  try {
    // --- Discord REST (ギルド情報) ---
    const guildRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}?with_counts=true`, {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
    });
    if (!guildRes.ok) throw new Error(`Guild fetch failed: ${guildRes.status}`);
    const guildData = await guildRes.json();

    // --- Owner 情報 ---
    const ownerRes = await fetch(
      `https://discord.com/api/v10/users/1208358513580052500`,
      { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } }
    );
    if (!ownerRes.ok) throw new Error(`Owner fetch failed: ${ownerRes.status}`);
    const ownerData = await ownerRes.json();

    // --- VC 情報（Gateway / client） ---
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) throw new Error("Guild not found in client");

    let totalVC = 0;
    const voice_detail = {};

    guild.channels.cache
      .filter(ch => ch.type === 2) // 2 = GuildVoice
      .forEach(ch => {
        const members = ch.members.map(m => m.user.id);

        if (members.length > 0) {
          voice_detail[ch.id] = members;
          totalVC += members.length;
        }
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
        voice: totalVC,
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

app.get("/api/events", async (req, res) => {
  try {
    const eventsRes = await fetch(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/scheduled-events?with_user_count=true`,
      { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } }
    );

    if (!eventsRes.ok) {
      throw new Error(`Events fetch failed: ${eventsRes.status}`);
    }

    const events = await eventsRes.json();

    // 整形（見やすくしたい場合）
    const formatted = events.map(ev => ({
      id: ev.id,
      name: ev.name,
      description: ev.description,
      creator_id: ev.creator_id,
      scheduled_start: ev.scheduled_start_time,
      scheduled_end: ev.scheduled_end_time,
      status: ev.status, // 1: Scheduled, 2: Active, 3: Completed, 4: Canceled
      entity_type: ev.entity_type, // 1: Stage, 2: Voice, 3: External
      user_count: ev.user_count || 0,
      channel_id: ev.channel_id,
      cover: ev.image
        ? `https://cdn.discordapp.com/guild-events/${ev.id}/${ev.image}.png`
        : null
    }));

    res.json({
      status: 200,
      timestamp: nowJST(),
      events: formatted
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: 500,
      error: err.message
    });
  }
});

//API側からバージョンを確認するため
app.get("/version", async (req, res) => {
  try{
    res.json({
             status: 200,
             version: "さくらbot V1"
      });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: 500,
      error: err.message
    });
  }
});

app.get("/api/invites/:code", async (req, res) => {
  const inviteCode = req.params.code
    .replace(".gg", "")
    .replace("discord.gg/", "")
    .replace("discord.com/invite/","");

  try {
    const response = await fetch(
      `https://discord.com/api/v10/invites/${inviteCode}?with_counts=true`,
      {
        method: "GET",
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        },
      }
    );

    if (response.status === 404) {
      return res.status(404).json({
        status: 404,
        message: "Invite not found or expired",
        match: false,
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        status: response.status,
        message: "Discord API error",
        match: false,
      });
    }

    const data = await response.json();

    // 招待コードのギルドID（存在しない場合もある）
    const inviteGuildId = data.guild?.id || null;

    // 一致判定
    const isMatch = inviteGuildId === GUILD_ID;

    return res.json({
      status: 200,
      invite: {
        code: data.code,
        guild: data.guild
          ? { id: data.guild.id, name: data.guild.name }
          : null,
        channel: data.channel
          ? { id: data.channel.id, name: data.channel.name }
          : null,
      },
      match: isMatch,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      status: 500,
      message: "Internal server error",
      match: false,
    });
  }
});

app.get("/shards/status", (_, res) => {
  if (!shardState.shards.length) {
    return res.status(503).json({
      ok: false,
      reason: "shard data not ready"
    });
  }
const date = new Date(shardState.updatedAt * 1000);
const localDateString = date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  res.json({
    ok: true,
    updatedAt: localDateString,
    shards: shardState.shards
  });
});

// 📌 /odai → HTML直書き + お題追加フォーム
app.get("/odai", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>今日のお題 管理ページ</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    h1 { color: #00bfff; }
    input, button { font-size: 1em; padding: 5px; margin-top: 5px; }
  </style>
</head>
<body>
  <h1>今日のお題 追加ページ</h1>

  <h2>お題追加</h2>
  <form method="POST" action="/odai/add">
    <input type="text" name="topic" placeholder="<例: 好きな物は？>" required>
    <button type="submit">追加</button>
  </form>

  <h2>現在のお題一覧</h2>
  <ul id="topic-list"></ul>

  <script>
    async function fetchTopics() {
      const res = await fetch("/odai/list");
      const data = await res.json();
      const list = document.getElementById("topic-list");
      list.innerHTML = "";
      data.forEach(t => {
        const li = document.createElement("li");
        li.textContent = t.text + (t.used ? " ✅" : "");
        list.appendChild(li);
      });
    }
    fetchTopics();
  </script>
</body>
</html>
  `);
});

// 📌 お題一覧 API
app.get("/odai/list", async (req, res) => {
  const { data, error } = await supabase
    .from("odai")
    .select("*")
    .order("id", { ascending: true });
  if (error) return res.json([]);
  res.json(data);
});

// 📌 お題追加 API（フォーム・JSON両方対応）
app.post("/odai/add", async (req, res) => {
  let topic = req.body.topic || (req.body.topic && req.body.topic.trim());
  if (!topic || topic.trim() === "") {
    return res.send("空のトピックは追加できません");
  }

  const { error } = await supabase
    .from("odai")
    .insert({ text: topic.trim(), used: false });

  if (error) return res.send("追加に失敗しました");

  // 追加後はページリロード
  res.redirect("/odai");
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));
