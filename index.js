import { ShardingManager } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const manager = new ShardingManager('./bot.js', {
  token: process.env.DISCORD_BOT_TOKEN,
  totalShards: '5', // or 数字指定
});

manager.on('shardCreate', shard => {
  console.log(`シャード ${shard.id} が起動しました`);
});

manager.spawn();
