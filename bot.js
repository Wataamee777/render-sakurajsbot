// bot.js
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
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  NoSubscriberBehavior
} from '@discordjs/voice';
import ytdl from 'ytdl-core';
import { supabase, upsertUser, insertUserIpIfNotExists, getUserIpOwner, insertAuthLog, getPinnedByChannel, insertPinned, updatePinnedMessage, deletePinned } from './db.js';

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_GUILD_ID,
  DISCORD_ROLE_ID,
  DISCORD_CHAT_CHANNEL_ID,
  DISCORD_MOD_LOG_CHANNEL_ID,
  VPN_API_KEY,
  REDIRECT_URI
} = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID || !DISCORD_ROLE_ID || !VPN_API_KEY || !REDIRECT_URI) {
  throw new Error('環境変数が足りてないよ！');
}

const queues = new Map();

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  rest: {
    rejectOnRateLimit: (info) => {
      console.warn('🚨 Rate limit hit!', info);
      return true;
    }
  }
});

// --- IP helpers ---
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
  } catch (e) {
    console.warn('VPN check failed', e);
    return false;
  }
}

// --- OAuth callback ---
export async function handleOAuthCallback({ code, ip }) {
  if (!code || !ip) throw new Error('認証情報が不正です');
  const ipHash = hashIP(ip);

  // token
  const basicAuth = Buffer.from(`${DISCORD_CLIENT_ID}:${DISCORD_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('トークン取得失敗');

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  const user = await userRes.json();
  if (!user.id) throw new Error('ユーザー情報取得失敗');

  const isVpn = await checkVPN(ip);
  if (isVpn) {
    await insertAuthLog(user.id, 'vpn_detected', `IP:${ip}`);
    throw new Error('VPN検知');
  }

  const ownerDiscordId = await getUserIpOwner(ipHash);
  if (ownerDiscordId && ownerDiscordId !== user.id) {
    await insertAuthLog(user.id, 'sub_account_blocked', `IP重複 IP:${ipHash}`);
    throw new Error('サブアカウント検知');
  }

  // DB upsert user
  await upsertUser(user.id, user.username);

  if (!ownerDiscordId) {
    await insertUserIpIfNotExists(user.id, ipHash);
  }

  await insertAuthLog(user.id, 'auth_success', `認証成功 IP:${ipHash}`);

  // role & notifications
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const member = await guild.members.fetch(user.id);
  if (!member.roles.cache.has(DISCORD_ROLE_ID)) await member.roles.add(DISCORD_ROLE_ID).catch(() => {});

  try {
    const chatChan = await guild.channels.fetch(DISCORD_CHAT_CHANNEL_ID);
    if (chatChan?.isTextBased()) chatChan.send(`🎉 ようこそ <@${user.id}> さん！`).catch(() => {});
  } catch {}

  try {
    const modChan = await guild.channels.fetch(DISCORD_MOD_LOG_CHANNEL_ID);
    if (modChan?.isTextBased()) modChan.send(`📝 認証成功: <@${user.id}> (${user.username}) IPハッシュ: \`${ipHash}\``).catch(() => {});
  } catch {}

  return `<h1>認証完了 🎉 ${user.username} さん</h1>`;
}

// --- commands registration ---
const commands = [
  
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('サーバーへの接続とリソースを表示します。'),

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
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

  new SlashCommandBuilder()
    .setName('play')
    .setDescription('🎶 音楽を再生します')
    .addStringOption(opt => opt.setName('url').setDescription('YouTubeのURL').setRequired(true)),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('⏭️ 現在の曲をスキップします'),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('🛑 現在のキューの再生を停止して退出します'),

  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('📜 現在の再生キューを表示します'),
    
  new SlashCommandBuilder()
    .setName('gatyareload')
    .setDescription('ガチャの設定を再読み込みします。')

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

// pinned table check note: with Supabase you'd usually create tables via migration
async function ensurePinnedTableExists() {
  // try to SELECT to detect table existence
  try {
    const { error } = await supabase.from('pinned_messages').select('channel_id').limit(1);
    if (error) {
      console.warn('pinned_messages table check failed. Make sure migration created the table.', error);
    }
  } catch (e) {
    console.warn('pinned_messages table check unexpected error', e);
  }
}
ensurePinnedTableExists();

// interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try {
    if(commandName === 'ping'){
      const uptime = process.uptime();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsage = (usedMem / totalMem * 100).toFixed(1);

      const cpus = os.cpus();
      const avgIdle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0) / cpus.length;
      const avgTotal = cpus.reduce((acc, cpu) =>
        acc + cpu.times.idle + cpu.times.user + cpu.times.sys + cpu.times.irq + cpu.times.nice, 0
      ) / cpus.length;
      const cpuUsage = (100 - (avgIdle / avgTotal * 100)).toFixed(1);

      const embed = new EmbedBuilder()
        .setTitle("Pong")
        .setColor(0x4dd0e1)
        .addFields(
          { name: "Bot Uptime", value: `${(uptime / 60).toFixed(1)} min`, inline: true },
          { name: "Memory Usage", value: `${memUsage}%`, inline: true },
          { name: "CPU Usage", value: `${cpuUsage}%`, inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'auth') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: '❌ 管理者のみ使用可能です', flags: 64 });
      }
      const authUrl = `https://bot.sakurahp.f5.si/auth`;
      const embed = new EmbedBuilder()
        .setTitle('🔐 認証パネル')
        .setDescription('以下のボタンから認証を進めてください。')
        .setColor(0x5865F2);
      const row = new ActionRowBuilder()
        .addComponents(new ButtonBuilder().setLabel('認証サイトへ').setStyle(ButtonStyle.Link).setURL(authUrl));
      return interaction.reply({ embeds: [embed], components: [row], flags: 64 });
    }

    if (commandName === 'report') {
      await interaction.deferReply({ ephemeral: true });
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

      const reportChannel = await client.channels.fetch(1208987840462200882).catch(() => null);
      if (!reportChannel?.isTextBased()) return interaction.editReply('❌ 通報チャンネルが見つかりません');

      if (file) await reportChannel.send({ embeds: [reportEmbed], files: [{ attachment: file.url }] });
      else await reportChannel.send({ embeds: [reportEmbed] });

      return interaction.editReply('✅ 通報を送信しました！');
    }

    if (commandName === 'pin') {
      const msg = interaction.options.getString('msg');
      const channelId = interaction.channel.id;

      const existing = await getPinnedByChannel(channelId);
      if (existing)
        return interaction.reply({ content: '⚠️ すでに固定メッセージがあります /unpin で解除してください', flags: 64 });

      const embed = new EmbedBuilder()
        .setDescription(msg)
        .setColor(0x00AE86)
        .setFooter({ text: `📌 投稿者: ${interaction.user.tag}` })
        .setTimestamp();

      const sent = await interaction.channel.send({ embeds: [embed] });
      await insertPinned(channelId, sent.id, msg, interaction.user.tag);

      return interaction.reply({ content: '📌 メッセージを固定しました！', flags: 64 });
    }

    if (commandName === 'unpin') {
      const channelId = interaction.channel.id;
      const existing = await getPinnedByChannel(channelId);
      if (!existing) return interaction.reply({ content: '❌ このチャンネルには固定メッセージがありません', flags: 64 });

      const pinnedMsgId = existing.message_id;
      const msg = await interaction.channel.messages.fetch(pinnedMsgId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
      await deletePinned(channelId);

      return interaction.reply({ content: '🗑️ 固定メッセージを解除しました！', flags: 64 });
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
    if (!interaction.replied && !interaction.deferred)
      interaction.reply({ content: '❌ エラーが発生しました', flags: 64 }).catch(() => {});
  }

  // --- /play ---
  if (interaction.commandName === 'play') {
    const url = interaction.options.getString('url');
    const voiceChannel = interaction.member?.voice?.channel;
    if (interaction.replied || interaction.deferred) return;
    await interaction.deferReply({ ephemeral: false }).catch(console.error);

    if (!voiceChannel)
      return interaction.editReply({ content: '❌ まずボイスチャンネルに参加してね！', ephemeral: true });

    let guildQueue = queues.get(interaction.guild.id);
    if (!guildQueue) {
      guildQueue = {
        connection: null,
        player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } }),
        songs: [],
        playing: false,
        textChannel: interaction.channel,
      };
      queues.set(interaction.guild.id, guildQueue);
    }

    try {
      if (!ytdl.validateURL(url)) {
        return interaction.editReply('⚠️ 有効なYouTube URLを入れてね！');
      }

      const info = await ytdl.getInfo(url);
      const title = info.videoDetails.title;
      const stream = ytdl(url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
      });

      guildQueue.songs.push({
        title,
        url,
        stream,
        type: 'opus'
      });

      if (!guildQueue.playing) {
        guildQueue.playing = true;
        guildQueue.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });
        playNext(interaction.guild.id);
      }

      await interaction.editReply(`🎶 **${title}** を再生キューに追加したよ！`);
    } catch (err) {
      console.error('再生エラー詳細:', err);
      await interaction.editReply('💥 再生中にエラーが発生しました…');
    }
  }

  // --- /skip ---
  if (interaction.commandName === 'skip') {
    const guildQueue = queues.get(interaction.guild.id);
    if (!guildQueue || guildQueue.songs.length <= 1)
      return interaction.reply('⚠️ スキップできる曲がないよ！');
    guildQueue.player.stop(true);
    interaction.reply('⏭️ スキップしたよ！');
  }

  // --- /stop ---
  if (interaction.commandName === 'stop') {
    const guildQueue = queues.get(interaction.guild.id);
    if (!guildQueue) return interaction.reply('⚠️ 何も再生してないよ！');
    guildQueue.songs = [];
    guildQueue.player.stop();
    if (guildQueue.connection) guildQueue.connection.destroy();
    queues.delete(interaction.guild.id);
    interaction.reply('🛑 再生を停止して退出したよ！');
  }

  // --- /playlist ---
  if (interaction.commandName === 'playlist') {
    const guildQueue = queues.get(interaction.guild.id);
    if (!guildQueue || guildQueue.songs.length === 0)
      return interaction.reply('📭 再生中のプレイリストは空っぽ！');

    const list = guildQueue.songs
      .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`)
      .join('\n');
    interaction.reply(`🎵 **再生キュー:**\n${list}`);
  }
});

// playNext
function playNext(guildId) {
  const guildQueue = queues.get(guildId);
  if (!guildQueue || guildQueue.songs.length === 0) {
    if (guildQueue?.connection) guildQueue.connection.destroy();
    queues.delete(guildId);
    return;
  }

  const song = guildQueue.songs[0];
  if (!song || !song.stream) {
    console.error("ストリームが生成されてない or song missing");
    guildQueue.songs.shift();
    return playNext(guildId);
  }

  const resource = createAudioResource(song.stream);
  guildQueue.player.play(resource);
  guildQueue.connection.subscribe(guildQueue.player);

  guildQueue.player.removeAllListeners(AudioPlayerStatus.Idle);
  guildQueue.player.on(AudioPlayerStatus.Idle, () => {
    guildQueue.songs.shift();
    playNext(guildId);
  });

  guildQueue.player.on('error', (err) => {
    console.error('Audio player error', err);
    // drop current and continue
    try {
      guildQueue.songs.shift();
      playNext(guildId);
    } catch (e) { console.error(e); }
  });
}

// VC 状態を保持
export const voiceStates = new Map(); // guildId → Map(userId → channelId)

client.on("voiceStateUpdate", (oldState, newState) => {
  const guildId = newState.guild.id;

  if (!voiceStates.has(guildId)) {
    voiceStates.set(guildId, new Map());
  }

  const guildMap = voiceStates.get(guildId);

  // 退出
  if (!newState.channelId) {
    guildMap.delete(newState.id);
    return;
  }

  // 入室 or 移動
  guildMap.set(newState.id, newState.channelId);
});

// pinned_messages update on messageCreate
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const channelId = message.channel.id;

  // avoid shards other than 0 updating DB
  if (client.shard && client.shard.ids[0] !== 0) return;

  try {
    const pinData = await getPinnedByChannel(channelId);
    if (!pinData) return;

    const oldMsg = await message.channel.messages.fetch(pinData.message_id).catch(() => null);
    if (oldMsg) await oldMsg.delete().catch(() => {});

    const embed = new EmbedBuilder()
      .setDescription(pinData.content)
      .setColor(0x00AE86)
      .setFooter({ text: `📌 投稿者: ${pinData.author_name || '不明'}` })
      .setTimestamp();

    const sent = await message.channel.send({ embeds: [embed] });
    await updatePinnedMessage(channelId, sent.id);
  } catch (err) {
    console.error('固定メッセージ更新エラー:', err);
  }
});

// ready
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

client.login(DISCORD_BOT_TOKEN)
