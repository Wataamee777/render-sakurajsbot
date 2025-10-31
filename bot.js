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
  `;
}

// --- コマンド登録 ---
const commands = [
  new SlashCommandBuilder()
    .setName('auth')
    .setDescription('認証用リンクを表示します')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator), // 管理者のみ
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('ユーザーを通報します')
    .addStringOption(opt =>
      opt.setName('userid').setDescription('通報するユーザーid').setRequired(true))
    .addStringOption(opt =>
      opt.setName('reason').setDescription('通報理由').setRequired(true))
    .addAttachmentOption(opt =>
      opt.setName('file').setDescription('証拠画像（任意）'))
].map(c => c.toJSON());

// --- コマンド登録処理 ---
const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
(async () => {
  try {
    console.log('スラッシュコマンド登録中...');
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log('✅ コマンド登録完了');
  } catch (err) {
    console.error('❌ コマンド登録失敗:', err);
  }
})();

// --- コマンド応答 ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // /auth
  if (commandName === 'auth') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ 管理者のみ使用可能なコマンドです。', ephemeral: true });
    }

    const authUrl = `https://auth.sakurahp.f5.si/auth`;

    const embed = new EmbedBuilder()
      .setTitle('🔐 Discord認証パネル')
      .setDescription('以下のボタンから認証を進めてください。\nVPN・複数アカウントは制限される場合があります。')
      .setColor(0x5865F2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('認証サイトへ').setStyle(ButtonStyle.Link).setURL(authUrl)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  // /report
if (commandName === 'report') {
  await interaction.deferReply({ ephemeral: true }); // 処理中にする（1回目の応答）

  try {
    const userid = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason');
    const file = interaction.options.getAttachment('file');

    const reportEmbed = new EmbedBuilder()
      .setTitle('🚨 ユーザー通報')
      .setColor(0xED4245)
      .addFields(
        { name: '通報者', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
        { name: '対象ユーザー', value: `<@${userid}>`, inline: true },
        { name: '理由', value: reason }
      )
      .setTimestamp();

    const logChannel = await client.channels.fetch(1208987840462200882);
    await logChannel.send({ embeds: [reportEmbed], files: file ? [file] : [] });

    await interaction.editReply('✅ 通報を送信しました。'); // ←これで結果を上書き
  } catch (err) {
    console.error(err);
    await interaction.editReply('❌ 通報送信に失敗しました。'); // ←失敗時もここで上書き
  }
}
});

// --- 起動処理 ---
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
