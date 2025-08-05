import express from 'express';
import bodyParser from 'body-parser';
import { Client, GatewayIntentBits } from 'discord.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN; // Renderの環境変数にセットしてね
const GUILD_ID = '1208962938388484107';
const ROLE_ID = '1208972162593988608';

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
app.post('/assign-role', async (req, res) => {
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
