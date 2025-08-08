import express from 'express';
import bodyParser from 'body-parser';
import crypto from 'crypto';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_GUILD_ID,
  DISCORD_ROLE_ID,
  NEON_DB_CONNECTION_STRING,
  VPN_API_KEY,
  REDIRECT_URI
} = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID || !DISCORD_ROLE_ID || !NEON_DB_CONNECTION_STRING || !VPN_API_KEY || !REDIRECT_URI) {
  throw new Error('環境変数が足りてないよ！');
}

const pool = new Pool({
  connectionString: NEON_DB_CONNECTION_STRING,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

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
  } catch {
    return false; // チェック失敗時は弾かずに通す
  }
}

// スラッシュコマンド登録
const commands = [
  new SlashCommandBuilder()
    .setName('auth')
    .setDescription('認証ページの案内を表示します')
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log('✅ /auth コマンド登録完了');
  } catch (e) {
    console.error('コマンド登録エラー:', e);
  }
}

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
  registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'auth') {
    const embed = new EmbedBuilder()
      .setTitle('Discord認証ページへ')
      .setDescription('下のボタンから認証ページにアクセスしてね')
      .setColor(0x5865F2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('認証ページへ')
        .setStyle(ButtonStyle.Link)
        .setURL('https://sakurajsbot-auth.onrender.com/auth')
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
  }
});

client.login(DISCORD_BOT_TOKEN);

app.get('/auth/', (req, res) => {
  res.send(`
    <h1>認証ページへようこそ</h1>
    <p><a href="https://discord.com/oauth2/authorize?client_id=1350015325055221770&redirect_uri=https%3A%2F%2Fsakurajsbot-auth.onrender.com%2Fauth%2Fcallback&response_type=code&scope=identify">Discordで認証する</a></p>
  `);
});

// OAuthコールバック処理
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  const rawIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ip = extractGlobalIP(rawIP);

  if (!code) return res.status(400).send('認証コードがありません');
  if (!ip) return res.status(400).send('グローバルIPが取得できません');

  const ipHash = hashIP(ip);

  try {
    // Discord トークン取得（Basic認証方式）
    const basicAuth = Buffer.from(
      `${process.env.DISCORD_CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`
    ).toString('base64');
    
const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${basicAuth}`
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI
  })
});

const tokenData = await tokenRes.json();
if (!tokenData.access_token) {
  return res.status(400).send(`トークン取得失敗: ${JSON.stringify(tokenData)}`);
}
    
    // ユーザー情報取得
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();
    if (!user.id) return res.status(400).send('ユーザー情報取得失敗');

    // VPNチェック
    const isVpn = await checkVPN(ip);
    if (isVpn) {
      await pool.query(
        `INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1, $2, $3)`,
        [user.id, 'vpn_detected', `IP: ${ip}`]
      );
      return res.status(403).send('VPNを検知しました。管理者に連絡してください。');
    }

    // IP重複チェック
    const ipDup = await pool.query(`SELECT discord_id FROM user_ips WHERE ip_hash=$1`, [ipHash]);
    if (ipDup.rowCount > 0 && ipDup.rows[0].discord_id !== user.id) {
      await pool.query(
        `INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1, $2, $3)`,
        [user.id, 'sub_account_blocked', `IP重複検知 IP: ${ipDup}`]
      );
      return res.status(403).send('サブアカウントを検知しました。管理者に連絡してください。');
    }

    // ユーザー登録/更新
    await pool.query(`
      INSERT INTO users(discord_id, username)
      VALUES ($1, $2)
      ON CONFLICT (discord_id) DO UPDATE SET username=EXCLUDED.username
    `, [user.id, `${user.username}#${user.discriminator}`]);

    // IP登録
    if (ipDup.rowCount === 0) {
      await pool.query(`INSERT INTO user_ips(discord_id, ip_hash) VALUES ($1, $2)`, [user.id, ipHash]);
    }

    // 認証ログ記録
    await pool.query(
      `INSERT INTO auth_logs(discord_id, event_type, detail) VALUES($1, 'auth_success', $2)`,
      [user.id, `認証成功 IP: ${ipDup}`]
    );

    // ロール付与
    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    const member = await guild.members.fetch(user.id);
    if (!member.roles.cache.has(DISCORD_ROLE_ID)) {
      await member.roles.add(DISCORD_ROLE_ID);
      console.log(`Role added to user ${user.id}`);
    }

    // 完了画面
    res.send(`
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
    res.status(500).send('サーバーエラーが発生しました。管理者に連絡してください。');
  }
});

// Hello World
app.get('/', (req, res) => {
  res.send('<h1>Hello World</h1><p>Bot稼働中です</p>');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
