import { ShardingManager } from 'discord.js';
import dotenv from 'dotenv';
import './web.js';

dotenv.config();

const totalShards = 2; // ここは環境やサーバー数に応じて数値にする
const manager = new ShardingManager('./bot.js', {
  token: process.env.DISCORD_BOT_TOKEN,
  totalShards: totalShards
});

manager.on('shardCreate', shard => {
  console.log(`シャード ${shard.id} が起動しました`);
});

manager.spawn();
