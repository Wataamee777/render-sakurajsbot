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
  PermissionsBitField
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

// --- PostgreSQL Pool ---
const pool = new Pool({
  connectionString: NEON_DB_CONNECTION_STRING,
  ssl: { rejectUnauthorized: true }
});

// --- Discord Client ---
export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- IP ユーティリティ ---
export function hashIP(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

export function extractGlobalIP(ipString) {
  if (!ipString) return null;
  const ips = ipString.split(',').map(ip => ip.trim());
  for (const ip of ips) if (isGlobalIP(ip)) return ip;
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

  // --- トークン取得 ---
  const basicAuth = Buffer.from(`${DISCORD_CLIENT_ID}:${DISCORD_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('トークン取得失敗');

  // --- ユーザー情報取得 ---
  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  const user = await userRes.json();
  if (!user.id) throw new Error('ユーザー情報取得失敗');

  // --- VPN チェック ---
  const isVpn = await checkVPN(ip);
  if (isVpn) {
    await pool.query(`INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1,'vpn_detected',$2)`, [user.id, `IP:${ip}`]);
    throw new Error('VPN検知');
  }

  // --- IP 重複チェック ---
  const ipDup = await pool.query(`SELECT discord_id FROM user_ips WHERE ip_hash=$1`, [ipHash]);
  if (ipDup.rowCount > 0 && ipDup.rows[0].discord_id !== user.id) {
    await pool.query(`INSERT INTO auth_logs(discord_id,event_type,detail) VALUES($1,'sub_account_blocked',$2)`, [user.id, `IP重複 IP:${ipHash}`]);
    throw new Error('サブアカウント検知');
  }

  // --- DB 登録 ---
  await pool.query(`
    INSERT INTO users(discord_id, username)
    VALUES($1,$2)
    ON CONFLICT (discord_id) DO UPDATE SET username=EXCLUDED.username
  `, [user.id, user.username]);

  if (ipDup.rowCount === 0) {
    await pool.query(`INSERT INTO user_ips(discord_id,ip_hash) VALUES($1,$2)`, [user.id, ipHash]);
  }

  await pool.query(`INSERT INTO auth_logs(discord_id,event_type,detail) VALUES($1,'auth_success',$2)`, [user.id, `認証成功 IP:${ipHash}`]);

  // --- ロール付与 & チャンネル通知 ---
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const member = await guild.members.fetch(user.id);
  if (!member.roles.cache.has(DISCORD_ROLE_ID)) await member.roles.add(DISCORD_ROLE_ID);

  try {
    const chatChan = await guild.channels.fetch(DISCORD_CHAT_CHANNEL_ID);
    if (chatChan?.isTextBased()) chatChan.send(`🎉 ようこそ <@${user.id}> さん！`);
  } catch { /* 無視 */ }

  try {
    const modChan = await guild.channels.fetch(DISCORD_MOD_LOG_CHANNEL_ID);
    if (modChan?.isTextBased()) modChan.send(`📝 認証成功: <@${user.id}> (${user.username}) IPハッシュ: \`${ipHash}\``);
  } catch { /* 無視 */ }

  return `<h1>認証完了 🎉 ${user.username} さん</h1>`;
}

// --- スラッシュコマンド ---
const commands = [
  new SlashCommandBuilder()
    .setName('auth')
    .setDescription('認証用リンクを表示します')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  new SlashCommandBuilder()
    .setName('report')
    .setDescription('ユーザーを通報します')
    .addStringOption(opt => opt.setName('userid').setDescription('通報するユーザーID').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('通報理由').setRequired(true))
    .addAttachmentOption(opt => opt.setName('file').setDescription('証拠画像（任意）')),

  new SlashCommandBuilder()
    .setName('pin')
    .setDescription('チャンネルにメッセージを固定します')
    .addStringOption(opt => opt.setName('msg').setDescription('固定する内容').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  new SlashCommandBuilder()
    .setName('unpin')
    .setDescription('チャンネルの固定メッセージを解除します')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('スラッシュコマンド登録中...');
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
    console.log('✅ コマンド登録完了');
  } catch (err) {
    console.error('❌ コマンド登録失敗:', err);
  }
})();

// --- /pin / /unpin の DB テーブル ---
async function ensurePinTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pinned_messages (
      channel_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL
    );
  `);
}
ensurePinTable();

// --- コマンド応答 ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // /auth
  if (commandName === 'auth') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ 管理者のみ使用可能です', flags: 64 });
    }
    const authUrl = `https://bot.sakurahp.f5.si/auth`;
    const embed = new EmbedBuilder().setTitle('🔐 認証パネル').setDescription('以下のボタンから認証を進めてください。').setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('認証サイトへ').setStyle(ButtonStyle.Link).setURL(authUrl));
    return interaction.reply({ embeds: [embed], components: [row], flags: 64 });
  }

  // /report
  if (commandName === 'report') {
    await interaction.deferReply({ flags: 64 });
    const userid = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason');
    const file = interaction.options.getAttachment('file');

    const reportEmbed = new EmbedBuilder()
      .setTitle('🚨 ユーザー通報')
      .setColor(0xED4245)
      .addFields(
        { name: '通報者', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
        { name: '対象ユーザー', value: `<@${userid}> (${userid})`, inline: true },
        { name: '理由', value: reason }
      )
      .setTimestamp();

    const reportChannel = await client.channels.fetch(DISCORD_MOD_LOG_CHANNEL_ID);
    if (!reportChannel?.isTextBased()) return interaction.editReply('❌ 通報チャンネルが見つかりません');

    if (file) await reportChannel.send({ embeds: [reportEmbed], files: [{ attachment: file.url }] });
    else await reportChannel.send({ embeds: [reportEmbed] });

    return interaction.editReply('✅ 通報を送信しました！');
  }

  // /pin
  if (commandName === 'pin') {
    const msg = interaction.options.getString('msg');
    const channelId = interaction.channel.id;

    const res = await pool.query('SELECT message_id FROM pinned_messages WHERE channel_id=$1', [channelId]);
    if (res.rowCount > 0) return interaction.reply({ content: '⚠️ すでに固定メッセージがあります /unpin で解除してください', flags: 64 });

    const embed = new EmbedBuilder()
      .setDescription(msg)
      .setColor(0x00AE86)
      .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    const sent = await interaction.channel.send({ embeds: [embed] });
    await pool.query('INSERT INTO pinned_messages(channel_id,message_id) VALUES($1,$2)', [channelId, sent.id]);

    return interaction.reply({ content: '📌 メッセージを固定しました！', flags: 64 });
  }

  // /unpin
  if (commandName === 'unpin') {
    const channelId = interaction.channel.id;
    const res = await pool.query('SELECT message_id FROM pinned_messages WHERE channel_id=$1', [channelId]);
    if (res.rowCount === 0) return interaction.reply({ content: '❌ このチャンネルには固定メッセージがありません', flags: 64 });

    const pinnedMsgId = res.rows[0].message_id;
    const msg = await interaction.channel.messages.fetch(pinnedMsgId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
    await pool.query('DELETE FROM pinned_messages WHERE channel_id=$1', [channelId]);

    return interaction.reply({ content: '🗑️ 固定メッセージを解除しました！', flags: 64 });
  }
});

// --- 起動 ---
client.once('ready', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  const shardInfo = client.shard ? `${client.shard.ids[0] + 1}/${client.shard.count}` : '1/1';
  const ping = Math.round(client.ws.ping);

  client.user.setPresence({
    activities: [{ name: `Shard ${shardInfo} | Ping: ${ping}ms`, type: 0 }],
    status: 'online'
  });

  setInterval(() => {
    const pingNow = Math.round(client.ws.ping);
    client.user.setPresence({
      activities: [{ name: `Shard ${shardInfo} | Ping: ${pingNow}ms`, type: 0 }],
      status: 'online'
    });
  }, 10000);
});

client.login(DISCORD_BOT_TOKEN);
