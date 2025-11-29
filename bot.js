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
  AttachmentBuilder,
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
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import si from 'systeminformation';
import os from 'os';
import pidusage from 'pidusage';
import cron from "node-cron";
import { addTextXP, addVCXP, createAccount, deleteAccount, transferAccount, setSNS, getAccount, modifyXP, modifyLevel } from './account.js';
import { supabase, upsertUser, insertUserIpIfNotExists, getUserIpOwner, insertAuthLog, getPinnedByChannel, upsertPinned, deletePinned } from './db.js';

const width = 400;
const height = 400;
const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

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

const indicators = "abcdefghijklmnopqrstuvwxyz".split("").map(letter => ({
  key: letter,
  emoji: `🇦`.codePointAt(0) + (letter.charCodeAt(0) - 97)
}));

const wait = ms => new Promise(res => setTimeout(res, ms));

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
    .setName('msgpin')
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
    .setDescription('ガチャの設定を再読み込みします。'),

  new SlashCommandBuilder()
    .setName('gatyashow')
    .setDescription('ガチャのメモリに保持されている分を表示'),
    
  new SlashCommandBuilder()
    .setName("poll")
    .setDescription("投票を作成します")
    .addStringOption(option =>
      option
        .setName("title")
        .setDescription("投票のタイトル")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("data")
        .setDescription("選択肢（例: a_'赤',b_'青',c_'黄'）")
        .setRequired(true)
    ),
  // /account info
  new SlashCommandBuilder()
    .setName("account")
    .setDescription("Account commands")
    .addSubcommand(sub =>
      sub
        .setName("info")
        .setDescription("アカウント情報を表示")
        .addUserOption(o =>
          o.setName("user").setDescription("対象ユーザー")
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("settings")
        .setDescription("設定編集")
        .addStringOption(o =>
          o
            .setName("set")
            .setDescription("項目")
            .setRequired(true)
            .addChoices({ name: "sns", value: "sns" })
        )
        .addStringOption(o =>
          o
            .setName("type")
            .setDescription("サービス名")
            .setRequired(true)
            .addChoices(
              { name: "x", value: "x" },
              { name: "youtube", value: "youtube" },
              { name: "tiktok", value: "tiktok" },
              { name: "github", value: "github" }
            )
        )
        .addStringOption(o =>
          o
            .setName("value")
            .setDescription("IDやURL")
            .setRequired(true)
        )
    ),

  // /admin account create/delete/transfer
  new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Admin commands")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    
    .addSubcommand(sub =>
      sub
        .setName("account-create")
        .setDescription("アカウント作成")
        .addUserOption(o =>
          o.setName("user").setDescription("対象ユーザー").setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("account-delete")
        .setDescription("アカウント削除")
        .addUserOption(o =>
          o.setName("user").setDescription("対象ユーザー").setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("account-transfer")
        .setDescription("アカウント移行")
        .addUserOption(o =>
          o.setName("old").setDescription("旧ユーザー").setRequired(true)
        )
        .addUserOption(o =>
          o.setName("new").setDescription("新ユーザー").setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("account-xp")
        .setDescription("XP調整")
        .addStringOption(o =>
          o
            .setName("type")
            .setDescription("add or delete")
            .setRequired(true)
            .addChoices(
              { name: "add", value: "add" },
              { name: "delete", value: "delete" }
            )
        )
        .addIntegerOption(o =>
          o
            .setName("value")
            .setDescription("数値")
            .setRequired(true)
        )
        .addUserOption(o =>
          o.setName("user").setDescription("対象ユーザー").setRequired(true)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName("account-level")
        .setDescription("レベル調整")
        .addStringOption(o =>
          o
            .setName("type")
            .setDescription("add or delete")
            .setRequired(true)
            .addChoices(
              { name: "add", value: "add" },
              { name: "delete", value: "delete" }
            )
        )
        .addIntegerOption(o =>
          o.setName("value").setDescription("数値").setRequired(true)
        )
        .addUserOption(o =>
          o.setName("user").setDescription("対象ユーザー").setRequired(true)
        )
    ),
    new SlashCommandBuilder()
      .setName("record")
      .setDescription("録音コマンド")
      .addSubcommand(sc => sc.setName("start").setDescription("録音開始"))
      .addSubcommand(sc => sc.setName("stop").setDescription("録音停止"))
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

  if (interaction.commandName === 'ping')

  try {
    await interaction.deferReply() 
    // CPU使用率
    const loadData = await si.currentLoad().catch(() => ({ currentload: 0 }));
    const cpuLoad = loadData.currentload ? loadData.currentload.toFixed(1) : '0';

    // メモリ
    const mem = await si.mem().catch(() => ({ total: 0, available: 0 }));
    const memUsed = mem.total && mem.available ? ((mem.total - mem.available) / 1024 / 1024 / 1024).toFixed(2) : '0';
    const memFree = mem.available ? (mem.available / 1024 / 1024 / 1024).toFixed(2) : '0';
    const memTotal = mem.total ? (mem.total / 1024 / 1024 / 1024).toFixed(2) : '0';

    // ネットワーク
    const netStats = await si.networkStats().catch(() => [{ rx_sec:0, tx_sec:0 }]);
    const netSpeed = netStats[0] ? ((netStats[0].rx_sec + netStats[0].tx_sec)/1024/1024).toFixed(2) : '0';

    // CPU詳細
    const cpu = await si.cpu().catch(() => ({ brand: 'Unknown', cores: 0, logicalCores: 0, speed: 0 }));

    // uptime
    const uptime = os.uptime();
    const ping = Math.floor(Math.random() * 50) + 20; // 仮Ping

    // ドーナツグラフ
    const config = {
      type: 'doughnut',
      data: {
        labels: ['CPU %', 'メモリ使用', 'メモリ空き', 'ネットワーク MB/s'],
        datasets: [{
          data: [cpuLoad, memUsed, memFree, netSpeed],
          backgroundColor: ['#FF6384', '#36A2EB', '#4BC0C0', '#FFCE56'],
        }]
      },
      options: {
        plugins: { legend: { position: 'bottom' } },
        responsive: false,
      }
    };

    const buffer = await chartJSNodeCanvas.renderToBuffer(config);
    const attachment = new AttachmentBuilder(buffer, { name: 'stats.png' });

    // Embedで詳細情報も表示
    await interaction.editReply({
      content: `CPU: ${cpu.brand}\nコア数: ${cpu.cores}, スレッド数: ${cpu.logicalCores}\nクロック: ${cpu.speed} GHz\nCPU使用率: ${cpuLoad} %\n稼働時間: ${Math.floor(uptime/60)} min\nPing: ${ping} ms\nネットワークスピード: ${netSpeed} MB/s、\nメモリ総量: ${memTotal} GB\n空きメモリ: ${memFree} GB`,
      files: [attachment]
    });

} catch (err) {
  console.error("Error in /ping:", err);

  if (interaction.deferred && !interaction.replied) {
    // defer 済み → editReply only
    await interaction.editReply("❌ エラーが発生しました").catch(console.error);
  } else if (!interaction.replied) {
    // defer できてなかった時
    await interaction.reply("❌ エラーが発生しました").catch(console.error);
  }
}

  if (interaction.commandName !== "poll") return;

  const title = interaction.options.getString("title");
  const rawData = interaction.options.getString("data");

  try {
    await interaction.deferReply({ ephemeral: false });

    const pairs = rawData.split(",").map(x => x.trim());
    const choices = [];

    for (const pair of pairs) {
      const match = pair.match(/^([a-z])_'(.+)'$/i);
      if (!match) continue;

      const key = match[1].toLowerCase();
      const text = match[2];

      choices.push({ key, text });
    }

    if (choices.length === 0) {
      return interaction.editReply("❌ データ形式が正しくないよ！");
    }

    const description = choices
      .map(c => `:regional_indicator_${c.key}:  ${c.text}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(0xff77aa);

    const sent = await interaction.editReply({ embeds: [embed] });

    for (const c of choices) {
      const base = "🇦".codePointAt(0);
      const offset = c.key.charCodeAt(0) - 97;
      const emoji = String.fromCodePoint(base + offset);

      await sent.react(emoji).catch(() => {});
      await wait(450); // 防レート制限
    }

  } catch (err) {
    console.error("Error in /poll:", err);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: "❌ エラーが発生したよ！", ephemeral: true }).catch(() => {});
    }
  }

    if (commandName === 'auth') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await interaction.reply({ content: '❌ 管理者のみ使用可能です', flags: 64 });
        return;
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

    if (commandName === 'msgpin') {
  await interaction.deferReply();
  const msg = interaction.options.getString('msg');
  const channelId = interaction.channel.id;

  const embed = new EmbedBuilder()
    .setDescription(msg)
    .setColor(0x00AE86)
    .setFooter({ text: `📌 投稿者: ${interaction.user.tag}` })
    .setTimestamp();

  const sent = await interaction.channel.send({ embeds: [embed] });
  await upsertPinned(channelId, sent.id, msg, interaction.user.tag);

  return interaction.editReply({ content: '📌 メッセージを固定しました！', flags: 64 });
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
  
//-/play ---
  if (commandName === 'play') {
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
  if (commandName === 'skip') {
    const guildQueue = queues.get(interaction.guild.id);
    if (!guildQueue || guildQueue.songs.length <= 1)
      return interaction.reply('⚠️ スキップできる曲がないよ！');
    guildQueue.player.stop(true);
    interaction.reply('⏭️ スキップしたよ！');
  }

  // --- /stop ---
  if (commandName === 'stop') {
    const guildQueue = queues.get(interaction.guild.id);
    if (!guildQueue) return interaction.reply('⚠️ 何も再生してないよ！');
    guildQueue.songs = [];
    guildQueue.player.stop();
    if (guildQueue.connection) guildQueue.connection.destroy();
    queues.delete(interaction.guild.id);
    interaction.reply('🛑 再生を停止して退出したよ！');
  }

  // --- /playlist ---
  if (commandName === 'playlist') {
    const guildQueue = queues.get(interaction.guild.id);
    if (!guildQueue || guildQueue.songs.length === 0)
      return interaction.reply('📭 再生中のプレイリストは空っぽ！');

    const list = guildQueue.songs
      .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`)
      .join('\n');
    interaction.reply(`🎵 **再生キュー:**\n${list}`);
  }

  if (commandName === 'gatyareload'){
    const embed = new EmbedBuilder()
        .setTitle("ガチャ設定再読み込み")
        .setColor(0x4dd0e1)
        .setDescription("設定の再読み込み処理を開始しました")
        .setTimestamp();

      interaction.reply({ embeds: [embed] });

      await GatyaLoad();
    }

  if (commandName === 'gatyalist') {
    try{
      if (forumThreadsData.length === 0) {
        return interaction.reply({ content: '❌ ガチャデータが読み込まれていません', ephemeral: true });
      }

      const embeds = forumThreadsData.map(thread => {
        const msgList = thread.messages.map(m => m.probability ? `${m.text} [${m.probability}]` : m.text);
        return new EmbedBuilder()
          .setTitle(thread.title)
          .setDescription(msgList.join('\n') || 'メッセージなし')
          .setFooter({ text: `Reply Channel: ${thread.replyChannel || '未設定'}` })
          .setColor(0xFFD700)
          .setTimestamp();
      });

      // Embed は 1 回に最大 10 件まで
      for (let i = 0; i < embeds.length; i += 10) {
        await interaction.reply({ embeds: embeds.slice(i, i + 10), ephemeral: true });
      }
    }catch(e){
      interaction.reply("エラー:" + e);
    }
  }
  if (!interaction.replied && !interaction.deferred) {
  interaction.reply({ content: '❌ エラーが発生しました', flags: 64 })
  .catch(console.error);
}
    
  // -----------------------
  // /account info
  // -----------------------
  if (interaction.commandName === "account" && interaction.options.getSubcommand() === "info") {
    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getUser("user") || interaction.user;

    const acc = await getAccount(target.id);
    if (!acc)
      return interaction.editReply({
        content: "このユーザーはまだアカウントありません！",
        ephemeral: true
      });

    return interaction.editReply({
      embeds: [
        {
          title: `${target.username} のアカウント情報`,
          fields: [
            { name: "XP", value: `${acc.xp}`, inline: true },
            { name: "VC XP", value: `${acc.vcxp}`, inline: true },
            { name: "Level", value: `${acc.level}`, inline: true },
            { name: "VC Level", value: `${acc.vclevel}`, inline: true },
            {
              name: "SNS",
              value: Object.keys(acc.sns || {}).length
                ? "```\n" + JSON.stringify(acc.sns, null, 2) + "\n```"
                : "未設定"
            }
          ]
        }
      ]
    });
  }

  // -----------------------
  // /account settings
  // -----------------------
  if (interaction.commandName === "account" && interaction.options.getSubcommand() === "settings") {
    await interaction.deferReply({ ephemeral: true });
    const set = interaction.options.getString("set");
    const type = interaction.options.getString("type");
    const value = interaction.options.getString("value");

    const err = await setSNS(interaction.user.id, type, value);
    if (err.error)
      return interaction.editReply("設定できませんでした…🥲");

    return interaction.editReply(`SNS **${type}** を **${value}** に設定したよ！`);
  }


  //==================================================
  // /admin account 系
  //==================================================
  if (interaction.commandName === "admin") {

    // アカウント作成
    if (interaction.options.getSubcommand() === "account-create") {
      await interaction.deferReply({ ephemeral: false });
      .catch(console.error);
      const user = interaction.options.getUser("user");
      const res = await createAccount(user.id);

      if (res.error === "AccountAlreadyExists")
        return interaction.editReply("そのユーザーはもう登録済みだよ！");

      return interaction.editReply(`アカウント作成完了！`);
    }

    // アカウント削除
    if (interaction.options.getSubcommand() === "account-delete") {
      await interaction.deferReply({ ephemeral: false });
      const user = interaction.options.getUser("user");
      await deleteAccount(user.id);
      return interaction.editReply("削除完了！");
    }

    // アカウント移行
    if (interaction.options.getSubcommand() === "account-transfer") {
      await interaction.deferReply({ ephemeral: false });

      const oldUser = interaction.options.getUser("old");
      const newUser = interaction.options.getUser("new");

      const res = await transferAccount(oldUser.id, newUser.id);

      if (res.error)
        return interaction.editReply(`エラー: ${res.error}`);

      return interaction.editReply("アカウント移行完了したよ！");
    }

    // XP操作
    if (interaction.options.getSubcommand() === "account-xp") {
      await interaction.deferReply({ ephemeral: false });
      const user = interaction.options.getUser("user");
      const type = interaction.options.getString("type");
      const value = interaction.options.getInteger("value");

      await modifyXP(user.id, type, value);
      return interaction.editReply(`XP を ${type} で ${value} 変更したよ！`);
    }

    // Level操作
    if (interaction.options.getSubcommand() === "account-level") {
      await interaction.deferReply({ ephemeral: false });
      const user = interaction.options.getUser("user");
      const type = interaction.options.getString("type");
      const value = interaction.options.getInteger("value");

      await modifyLevel(user.id, type, value);
      return interaction.editReply(`Level を ${type} で ${value} 変更したよ！`);
    }
  }
});
/* 
  ガチャのデータ読み込み
*/
export const forumThreadsData = []; // ガチャ一覧をメモリに保持
const GATYA_CHANNEL_ID = '1441416133302419506';

export async function GatyaLoad() {
  forumThreadsData.length = 0;

  let channel;
  try {
    channel = await client.channels.fetch(GATYA_CHANNEL_ID);
  } catch (e) {
    console.error('チャンネル取得に失敗:', e);
    return;
  }

  if (!channel || channel.type !== ChannelType.GuildForum) {
    console.error('指定のチャンネルはフォーラムではありません');
    return;
  }

  // アクティブスレッド
  try {
    const activeThreads = await channel.threads.fetchActive();
    await processThreads(activeThreads.threads);
  } catch (e) {
    console.error('アクティブスレッドの取得に失敗:', e);
  }

  // アーカイブ済みスレッド
  try {
    const archivedThreads = await channel.threads.fetchArchived({ type: 'public' });
    await processThreads(archivedThreads.threads);
  } catch (e) {
    console.error('アーカイブスレッドの取得に失敗:', e);
  }

  console.log(`GatyaLoad: ${forumThreadsData.length} スレッド読み込み完了`);
}

function extractProbability(text) {
  if (typeof text !== 'string') return { probability: "", text: "" };
  const match = text.match(/\[(\d+)]$/);
  if (match) {
    return { probability: match[1], text: text.slice(0, match.index).trim() };
  }
  return { probability: "", text };
}

async function processThreads(threads) {
  for (const [, thread] of threads) {
    const threadData = {
      id: thread.id,
      title: thread.name,
      replyChannel: thread.topic?.match(/\d+/)?.[0] ?? null,
      messages: []
    };

    let lastId;
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      let messages;
      try {
        messages = await thread.messages.fetch(options);
      } catch (e) {
        console.error(`スレッド ${thread.id} のメッセージ取得に失敗:`, e);
        break; // このスレッドは諦める
      }

      if (messages.size === 0) break;

      const sorted = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      sorted.forEach(msg => {
        try {
          const { probability, text } = extractProbability(msg.content);
          threadData.messages.push({ probability, text });
        } catch (e) {
          console.error(`スレッド ${thread.id} のメッセージ解析に失敗:`, e);
        }
      });

      lastId = messages.last().id;
    }

    forumThreadsData.push(threadData);
  }
}


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

const voiceTimes = new Map();

// VC 状態を保持
export const voiceStates = new Map(); // guildId → Map(userId → channelId)

client.on("voiceStateUpdate", async (oldState, newState) => {
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
  
await addVCXP(userId, xp);
const newLevel = await checkVCLevel(userId);

if (newLevel) {
  const channel = newState.guild.systemChannel;
  if (channel) channel.send(`<@${userId}> が **VC Lv.${newLevel}** にアップしたよ！！ 🎉`);
}

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
    await upsertPinned(channelId, sent.id);
  } catch (err) {
    console.error('固定メッセージ更新エラー:', err);
  }

  if (msg.author.bot) return;

  // 1〜10XP付与
  const gain = Math.floor(Math.random() * 10) + 1;
  await modifyXP(msg.author.id, "add", gain);

  const newLvl = await checkTextLevel(msg.author.id);
  if (newLvl) {
    msg.channel.send(`🎉 <@${msg.author.id}> が **Lv.${newLvl}** にアップしたよ！！`);
  }});

client.on('error', (err) => {
  if (err.code === 10062) {
    // Unknown interaction は無視
    console.warn('無視された DiscordAPIError[10062]');
    return;
  }
  console.error('Discord Client Error:', err);
});

// 📌 JST 5:00 の Cron ジョブ（お題送信）
cron.schedule(
  "0 5 * * *",
  async () => {
    try {
      console.log("📢 Sending daily odai…");

      let { data: unused } = await supabase
        .from("odai")
        .select("*")
        .eq("used", false);

      if (!unused || unused.length === 0) {
        console.log("🔄 Resetting all odai to unused…");
        await supabase.from("odai").update({ used: false });
        const res2 = await supabase
          .from("odai")
          .select("*")
          .eq("used", false);
        unused = res2.data;
      }

      const pick = unused[Math.floor(Math.random() * unused.length)];

      const channel = await client.channels.fetch(DISCORD_CHAT_CHANNEL_ID);
      await channel.send({
        embeds: [
          {
            title: "今日のお題",
            description: pick.text,
            color: 0x00bfff,
            footer: { text: "powered by <@1099098129338466385>" },
            timestamp: new Date().toISOString(),
          },
        ],
      });

      console.log("✨ Sent:", pick.text);

      await supabase
        .from("odai")
        .update({ used: true })
        .eq("id", pick.id);
    } catch (err) {
      console.error("❌ Cron error:", err);
    }
  },
  { timezone: "Asia/Tokyo" }
);

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
