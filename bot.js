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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
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
  // 🔐 /auth
  new SlashCommandBuilder()
    .setName('auth')
    .setDescription('認証用リンクを表示します')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  // 🚨 /report
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('ユーザーを通報します')
    .addStringOption(opt =>
      opt.setName('userid')
        .setDescription('通報するユーザーID')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('reason')
        .setDescription('通報理由')
        .setRequired(true))
    .addAttachmentOption(opt =>
      opt.setName('file')
        .setDescription('証拠画像（任意）')),

  // 📌 /pin
  new SlashCommandBuilder()
    .setName('pin')
    .setDescription('このチャンネルにメッセージを固定します')
    .addStringOption(opt =>
      opt.setName('msg')
        .setDescription('固定する内容')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  // 🔓 /unpin
  new SlashCommandBuilder()
    .setName('unpin')
    .setDescription('このチャンネルの固定メッセージを解除します')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
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

    const authUrl = `https://bot.sakurahp.f5.si/auth`;

    const embed = new EmbedBuilder()
      .setTitle('🔐 Discord認証パネル')
      .setDescription('以下のボタンから認証を進めてください。\nVPN・複数アカウントは制限される場合があります。')
      .setColor(0x5865F2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('認証サイトへ').setStyle(ButtonStyle.Link).setURL(authUrl)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }

if (commandName === 'report') {
  try {
    await interaction.deferReply({ ephemeral: true }); // ✅ flags→ephemeral

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

    // ✅ シャード対応 fetch方式
    let reportChannel;
    try {
      reportChannel = await interaction.client.channels.fetch('1208987840462200882');
    } catch (err) {
      console.error('チャンネル取得失敗:', err);
    }

    if (!reportChannel) {
      await interaction.editReply('❌ エラー: 通報ログチャンネルが見つかりません（404 not found channel）');
      return;
    }

    // ✅ ファイル送信対応
    if (file) {
      await reportChannel.send({ embeds: [reportEmbed], files: [{ attachment: file.url }] });
    } else {
      await reportChannel.send({ embeds: [reportEmbed] });
    }

    await interaction.editReply('✅ 通報を送信しました！');
  } catch (err) {
    console.error(err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ 通報に失敗しました。', ephemeral: true });
    } else {
      await interaction.editReply('❌ 通報に失敗しました。');
    }
  }
}

// 📌 /pin
if (commandName === 'pin') {
  const msg = interaction.options.getString('msg');
  const channel = interaction.channel;

  await interaction.deferReply({ ephemeral: true });

  // 既に登録済みなら削除して上書き
  const exist = await pool.query('SELECT * FROM pinned_messages WHERE channel_id = $1', [channel.id]);
  if (exist.rowCount > 0) {
    const oldMsg = await channel.messages.fetch(exist.rows[0].message_id).catch(() => null);
    if (oldMsg) await oldMsg.delete().catch(() => {});
    await pool.query('DELETE FROM pinned_messages WHERE channel_id = $1', [channel.id]);
  }

  const embed = new EmbedBuilder()
    .setDescription(msg)
    .setColor(0x00AE86)
    .setFooter({ 
      text: `📌 投稿者: ${interaction.user.tag}`, 
      iconURL: interaction.user.displayAvatarURL() 
    })
    .setTimestamp();

  const sent = await channel.send({ embeds: [embed] });

  // author_id を追加保存（テーブルにある場合用）
  await pool.query(`
    INSERT INTO pinned_messages (channel_id, message_id, content, author_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (channel_id)
    DO UPDATE SET message_id = EXCLUDED.message_id, content = EXCLUDED.content, author_id = EXCLUDED.author_id;
  `, [channel.id, sent.id, msg, interaction.user.id]);

  await interaction.editReply('✅ 固定メッセージを設定しました！');
}


// 🔓 /unpin
if (commandName === 'unpin') {
  const channelId = interaction.channel.id;

  await interaction.deferReply({ ephemeral: true }).catch(() => {}); // 安全に defer

  const result = await pool.query('SELECT message_id FROM pinned_messages WHERE channel_id = $1', [channelId]);
  if (result.rowCount === 0) {
    await interaction.editReply({ content: '❌ このチャンネルには固定メッセージがありません。' });
    return;
  }

  const pinnedMsgId = result.rows[0].message_id;
  const msg = await interaction.channel.messages.fetch(pinnedMsgId).catch(() => null);
  if (msg) await msg.delete().catch(() => {});

  await pool.query('DELETE FROM pinned_messages WHERE channel_id = $1', [channelId]);

  await interaction.editReply({ content: '🗑️ 固定メッセージを解除しました！' });
}
});
  
client.on('messageCreate', async message => {
  if (message.author.bot) return; // Botは無視
  const channelId = message.channel.id;

  // DBから固定メッセージ取得
  const result = await pool.query('SELECT * FROM pinned_messages WHERE channel_id = $1', [channelId]);
  if (result.rowCount === 0) return; // 固定メッセージなし

  const pinData = result.rows[0];

  // 既存メッセージ削除
  const oldMsg = await message.channel.messages.fetch(pinData.message_id).catch(() => null);
  if (oldMsg) await oldMsg.delete().catch(() => {});

  // 再送信
  const embed = new EmbedBuilder()
    .setDescription(pinData.content)
    .setColor(0x00AE86)
    .setFooter({ text: `📌 投稿者: ${pinData.author_id}` })
    .setTimestamp();

  const sent = await message.channel.send({ embeds: [embed] });

  // DB更新
  await pool.query('UPDATE pinned_messages SET message_id = $1, updated_at = NOW() WHERE channel_id = $2', [sent.id, channelId]);
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
