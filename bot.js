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
  DISCORD_CHAT_CHANNEL_ID,
  DISCORD_MOD_LOG_CHANNEL_ID,
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

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// --- IP関連ユーティリティ ---
export function hashIP(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

export function extractGlobalIP(ipString) {
  if (!ipString) return null;
  const ips = ipString.split(',').map(ip => ip.trim());
  for (const ip of ips) {
    if (isGlobalIP(ip)) return ip;
  }
  return null;
}

export function isGlobalIP(ip) {
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

export async function checkVPN(ip) {
  try {
    const res = await fetch(`https://vpnapi.io/api/${ip}?key=${VPN_API_KEY}`);
    const data = await res.json();
    return data.security && (data.security.vpn || data.security.proxy || data.security.tor || data.security.relay);
  } catch {
    return false;
  }
}

// --- OAuth コールバック処理 ---
export async function handleOAuthCallback({ code, ip }) {
  if (!code || !ip) throw new Error('認証情報が不正です');

  const ipHash = hashIP(ip);

  // トークン取得
  const basicAuth = Buffer.from(`${DISCORD_CLIENT_ID}:${DISCORD_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('トークン取得失敗');

  // ユーザー情報取得
  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  const user = await userRes.json();
  if (!user.id) throw new Error('ユーザー情報取得失敗');

  // VPNチェック
  const isVpn = await checkVPN(ip);
  if (isVpn) {
    await pool.query(`INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1,'vpn_detected',$2)`, [user.id, `IP:${ip}`]);
    throw new Error('VPN検知');
  }

  // IP重複チェック
  const ipDup = await pool.query(`SELECT discord_id FROM user_ips WHERE ip_hash=$1`, [ipHash]);
  if (ipDup.rowCount > 0 && ipDup.rows[0].discord_id !== user.id) {
    await pool.query(`INSERT INTO auth_logs(discord_id,event_type,detail) VALUES($1,'sub_account_blocked',$2)`, [user.id, `IP重複 IP:${ipHash}`]);
    throw new Error('サブアカウント検知');
  }

  // DB登録
  await pool.query(`
    INSERT INTO users(discord_id, username)
    VALUES($1,$2)
    ON CONFLICT (discord_id) DO UPDATE SET username=EXCLUDED.username
  `, [user.id, `${user.username}`]);

  if (ipDup.rowCount === 0) {
    await pool.query(`INSERT INTO user_ips(discord_id,ip_hash) VALUES($1,$2)`, [user.id, ipHash]);
  }

  await pool.query(`INSERT INTO auth_logs(discord_id,event_type,detail) VALUES($1,'auth_success',$2)`, [user.id, `認証成功 IP:${ipHash}`]);

  // ロール付与＆チャンネル通知
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const member = await guild.members.fetch(user.id);
  if (!member.roles.cache.has(DISCORD_ROLE_ID)) await member.roles.add(DISCORD_ROLE_ID);

  // 雑談チャンネル
  try {
    const chatChan = await guild.channels.fetch(DISCORD_CHAT_CHANNEL_ID);
    if (chatChan?.isTextBased()) chatChan.send(`🎉 ようこそ <@${user.id}> さん！`);
  } catch (err) { console.error("雑談送信失敗", err); }

  // モデ用ログ
  try {
    const modChan = await guild.channels.fetch(DISCORD_MOD_LOG_CHANNEL_ID);
    if (modChan?.isTextBased()) modChan.send(`📝 認証成功: <@${user.id}> (${user.username}) IPハッシュ: \`${ipHash}\``);
  } catch (err) { console.error("モデログ送信失敗", err); }

  // HTML文字列を返す
  return `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>認証完了</title>
      <style>
        body { font-family:'Segoe UI',sans-serif; background:#36393F; color:#FFF; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
        .container { text-align:center; background:#2F3136; padding:40px; border-radius:12px; box-shadow:0 0 20px rgba(0,0,0,0.5); }
        h1
