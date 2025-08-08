import express from 'express';
import bodyParser from 'body-parser';
import {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder,EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle} from 'discord.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN; // Renderの環境変数にセットしてね
const GUILD_ID = '1208962938388484107';
const ROLE_ID = '1208972162593988608';
const CLIENT_ID= '1350015325055221770'

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// Discord Botセットアップ
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

client.login(TOKEN);

// スラッシュコマンド登録
const commands = [
  new SlashCommandBuilder()
    .setName('auth')
    .setDescription('認証用リンクを表示します')
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('✅ グローバルコマンド登録完了');
}

// コマンド処理
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

 case 'auth': {
    const embed = new EmbedBuilder()
      .setTitle('認証が必要です')
      .setDescription('以下のボタンから認証を行ってください。')
      .setColor(0x5865F2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('認証ページへ')
        .setStyle(ButtonStyle.Link)
        .setURL(`${REDIRECT_URI}`)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  });

// ロール付与関数
async function assignRoleToUser(userId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(ROLE_ID)) {
      await member.roles.add(ROLE_ID);
      console.log(`Role added to user ${userId}`);
    } else {
      console.log(`User ${userId} already has the role.`);
    }
  } catch (err) {
    console.error('Role assignment error:', err);
    throw err;
  }
}

// ルート Hello World HTML返すだけ
app.get('/', (req, res) => {
  res.type('html').send(`
    <!DOCTYPE html>
    <html lang="ja">
    <head><meta charset="UTF-8"><title>Hello World</title></head>
    <body><h1>Hello World</h1><p>Botは稼働中です。</p></body>
    </html>
  `);
});

// ロール付与API
app.post('/add-role', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userIdが必要です' });

  try {
    await assignRoleToUser(userId);
    res.json({ success: true, message: `ロールを付与しました: ${userId}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// サーバースタート
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
