import bodyParser from 'body-parser';
import crypto from 'crypto';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ShardClientUtil
} from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_GUILD_ID,
  DISCORD_ROLE_ID,
  DISCORD_CHAT_CHANNEL_ID, // 雑談
  DISCORD_MOD_LOG_CHANNEL_ID, // モデ用
  NEON_DB_CONNECTION_STRING,
  VPN_API_KEY,
  REDIRECT_URI
} = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID || !DISCORD_ROLE_ID || !NEON_DB_CONNECTION_STRING || !VPN_API_KEY || !REDIRECT_URI) {
  throw new Error('環境変数が足りてないよ！');
}

const pool = new Pool({
  connectionString: NEON_DB_CONNECTION_STRING,
  ssl: { rejectUnauthorized: true }
});

const shardId = process.env.SHARD_ID || process.env.pm_id || '0'; // pm2互換対策も兼ねる
const isMaster = shardId === '0';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// IPハッシュ
function hashIP(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

// VPNチェック
async function checkVPN(ip) {
  try {
    const res = await fetch(`https://vpnapi.io/api/${ip}?key=${VPN_API_KEY}`);
    const data = await res.json();
    return data.security && (data.security.vpn || data.security.proxy || data.security.tor || data.security.relay);
  } catch {
    return false;
  }
}

// IPグローバル判定
function extractGlobalIP(ipString) {
  if (!ipString) return null;
  const ips = ipString.split(',').map(ip => ip.trim());
  for (const ip of ips) {
    if (isGlobalIP(ip)) return ip;
  }
  return null;
}
function isGlobalIP(ip) {
  if (!ip) return false;
  if (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('fc') ||
    ip.startsWith('fe80')
  ) return false;
  return true;
}

client.once('ready', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  // シャード数とPingをプレイ中に表示
  const shardCount = client.shard ? client.shard.count : 1;
  const ping = Math.round(client.ws.ping);

  client.user.setPresence({
    activities: [
      { name: `Ping: ${ping}ms | Shards: ${shardCount}`, type: 0 } // type: 0 は "Playing"
    ],
    status: 'online'
  });

  // 60秒ごとに更新
  setInterval(() => {
    const pingNow = Math.round(client.ws.ping);
    client.user.setPresence({
      activities: [
        { name: `Ping: ${pingNow}ms | Shards: ${shardCount}`, type: 0 }
      ],
      status: 'online'
    });
  }, 10000);
});

client.login(DISCORD_BOT_TOKEN);

// 認証ページ
app.get('/auth/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Discord認証</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; background:#36393F; color:#FFF; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; margin:0; }
        h1 { color:#7289DA; }
        a.button { display:inline-block; padding:15px 25px; margin-top:20px; font-size:18px; font-weight:bold; color:#FFF; background:#7289DA; border-radius:8px; text-decoration:none; transition:0.2s; }
        a.button:hover { background:#5b6eae; }
        .container { text-align:center; max-width:400px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>認証ページへようこそ</h1>
        <p>Discordで認証</p>
        <a class="button" href="https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify">Discordで認証する</a>
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
        <button onclick="location.href='https://bot.sakurahp.f5.si/'">利用規約&プライバリシーポリシーを見る</button>
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

// OAuthコールバック
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const rawIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ip = extractGlobalIP(rawIP);

  if (!code || !ip) return res.status(400).send('認証情報が不正です');

  const ipHash = hashIP(ip);

  try {
    // トークン取得
    const basicAuth = Buffer.from(`${DISCORD_CLIENT_ID}:${DISCORD_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type':'application/x-www-form-urlencoded',
        'Authorization':`Basic ${basicAuth}`
      },
      body: new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri:REDIRECT_URI })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).send('トークン取得失敗');

    // ユーザー情報取得
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers:{ Authorization:`Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();
    if (!user.id) return res.status(400).send('ユーザー情報取得失敗');

    // VPNチェック
    const isVpn = await checkVPN(ip);
    if (isVpn) {
      await pool.query(`INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1,'vpn_detected',$2)`,[user.id,`IP:${ip}`]);
      return res.status(403).send('VPN検知。管理者に連絡してください。');
    }

    // IP重複チェック
    const ipDup = await pool.query(`SELECT discord_id FROM user_ips WHERE ip_hash=$1`,[ipHash]);
    if (ipDup.rowCount>0 && ipDup.rows[0].discord_id!==user.id) {
      await pool.query(`INSERT INTO auth_logs(discord_id,event_type,detail) VALUES($1,'sub_account_blocked',$2)`,[user.id,`IP重複 IP:${ipHash}`]);
      return res.status(403).send('サブアカウント検知。管理者に連絡してください。');
    }

    // DB登録
    await pool.query(`
      INSERT INTO users(discord_id,username)
      VALUES($1,$2)
      ON CONFLICT (discord_id) DO UPDATE SET username=EXCLUDED.username
    `,[user.id,`${user.username}`]);

    if (ipDup.rowCount===0){
      await pool.query(`INSERT INTO user_ips(discord_id,ip_hash) VALUES($1,$2)`,[user.id,ipHash]);
    }

    await pool.query(`INSERT INTO auth_logs(discord_id,event_type,detail) VALUES($1,'auth_success',$2)`,[user.id,`認証成功 IP:${ipHash}`]);

    // ロール付与＆チャンネル通知
    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    const member = await guild.members.fetch(user.id);

    if (!member.roles.cache.has(DISCORD_ROLE_ID)) {
      await member.roles.add(DISCORD_ROLE_ID);
    }

    // 雑談チャンネル
    try {
      const chatChan = await guild.channels.fetch(DISCORD_CHAT_CHANNEL_ID);
      if(chatChan?.isTextBased()) {
        await chatChan.send(`🎉 ようこそ <@${user.id}> さん！\n<@&1210409196714074122> たち～ みんな仲良くしてあげてね！`);
      }
    } catch(err){ console.error("雑談送信失敗",err); }

    // モデ用ログ
    try {
      const modChan = await guild.channels.fetch(DISCORD_MOD_LOG_CHANNEL_ID);
      if(modChan?.isTextBased()) {
        await modChan.send(`📝 認証成功: <@${user.id}> (${user.username}) IPハッシュ: \`${ipHash}\``);
      }
    } catch(err){ console.error("モデログ送信失敗",err); }

    // 完了画面
    res.send(`
      <!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>認証完了</title>
        <style>
          body { font-family:'Segoe UI',sans-serif; background:#36393F; color:#FFF; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
          .container { text-align:center; background:#2F3136; padding:40px; border-radius:12px; box-shadow:0 0 20px rgba(0,0,0,0.5); }
          h1 { color:#7289DA; }
          p { font-size:18px; margin:10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>認証完了🎉</h1>
          <p>${user.username} さん、ようこそ！</p>
          <p>認証が完了し、ロールを付与しました。</p>
        </div>
      </body>
      </html>
    `);

  } catch(err) {
    console.error('認証エラー:', err);
    await pool.query(`INSERT INTO auth_logs(discord_id,event_type,detail) VALUES($1,'auth_error',$2)`,[null, err.message]);
    res.status(500).send('サーバーエラーが発生しました。管理者に連絡してください。');
  }
});

if (isMaster) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
} else {
  console.log(`Shard ${process.env.SHARD_ID} はWebサーバー起動なし`);
}
