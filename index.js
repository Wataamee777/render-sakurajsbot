import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import fetch from 'node-fetch'; // node18+なら標準fetch使える
import { Client, GatewayIntentBits } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DISCORD_ROLE_ID,
  NEON_DB_CONNECTION_STRING,
  VPN_API_KEY,
  REDIRECT_URI
} = process.env;

if (!DISCORD_BOT_TOKEN || !NEON_DB_CONNECTION_STRING || !VPN_API_KEY || !REDIRECT_URI) {
  throw new Error('必要な環境変数が設定されていません');
}

const pool = new Pool({
  connectionString: NEON_DB_CONNECTION_STRING,
  ssl: { rejectUnauthorized: false } // Neon用
});

const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.once('ready', () => {
  console.log(`Discord Bot Logged in as ${client.user.tag}`);
});
client.login(DISCORD_BOT_TOKEN);

// IPをSHA256でハッシュ化
function hashIP(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

// VPNチェックAPI
async function checkVPN(ip) {
  try {
    const res = await fetch(`https://vpnapi.io/api/${ip}?key=${VPN_API_KEY}`);
    const data = await res.json();
    return data.security && (data.security.vpn || data.security.proxy || data.security.tor || data.security.relay);
  } catch (e) {
    console.error('VPNチェック失敗:', e);
    return false; // チェック失敗時は弾かないで通すかは判断次第
  }
}

// Discord OAuth コールバック受け取りAPI
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (!code) return res.status(400).send('認証コードがありません');
  if (!ip) return res.status(400).send('IPが取得できません');

  const ipHash = hashIP(ip);

  try {
    // 1. Discord トークン取得
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_BOT_TOKEN, // ここはclient_secretに変えるなら別途環境変数用意して
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        scope: 'identify'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).send(`トークン取得失敗: ${JSON.stringify(tokenData)}`);
    }

    // 2. ユーザー情報取得
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();
    if (!user.id) return res.status(400).send('ユーザー情報取得失敗');

    // 3. VPNチェック
    const isVpn = await checkVPN(ip);
    if (isVpn) {
      await pool.query(
        `INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1, $2, $3)`,
        [user.id, 'vpn_detected', `IP: ${ip}`]
      );
      return res.status(403).send('VPNを検知しました。間違いの場合は管理者に連絡してください。');
    }

    // 4. IP重複チェック
    const ipDup = await pool.query(`SELECT discord_id FROM user_ips WHERE ip_hash=$1`, [ipHash]);
    if (ipDup.rowCount > 0 && ipDup.rows[0].discord_id !== user.id) {
      await pool.query(
        `INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1, $2, $3)`,
        [user.id, 'sub_account_blocked', `IP重複検知 IP: ${ip}`]
      );
      return res.status(403).send('サブアカウントを検知しました。間違いの場合は管理者に連絡してください。');
    }

    // 5. ユーザー情報登録/更新
    await pool.query(`
      INSERT INTO users(discord_id, username)
      VALUES ($1, $2)
      ON CONFLICT (discord_id) DO UPDATE SET username=EXCLUDED.username
    `, [user.id, `${user.username}#${user.discriminator}`]);

    // 6. IP登録（重複登録防止）
    if (ipDup.rowCount === 0) {
      await pool.query(`INSERT INTO user_ips(discord_id, ip_hash) VALUES ($1, $2)`, [user.id, ipHash]);
    }

    // 7. 認証ログ記録
    await pool.query(
      `INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1, 'auth_success', $2)`,
      [user.id, `認証成功 IP: ${ip}`]
    );

    // 8. Discordロール付与
    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    const member = await guild.members.fetch(user.id);
    if (!member.roles.cache.has(DISCORD_ROLE_ID)) {
      await member.roles.add(DISCORD_ROLE_ID);
      console.log(`Role added to user ${user.id}`);
    }

    // 9. 成功画面表示
    return res.send(`
      <h1>認証完了🎉</h1>
      <p>${user.username}#${user.discriminator} さん、ようこそ！</p>
      <p>認証が完了し、ロールを付与しました。</p>
    `);

  } catch (err) {
    console.error('認証エラー:', err);
    await pool.query(
      `INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1, 'auth_error', $2)`,
      [null, err.message]
    );
    return res.status(500).send('サーバーエラーが発生しました。管理者に連絡してください。');
  }
});

// Hello World
app.get('/', (req, res) => {
  res.send('<h1>Hello World</h1><p>Bot稼働中です</p>');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
