import { ShardingManager } from "discord.js";
import dotenv from "dotenv";
import https from "https";
import "./web.js";

dotenv.config();

export const shardState = {
  updatedAt: 0,
  shards: []
};

const totalShards = 2;

const manager = new ShardingManager("./bot.js", {
  token: process.env.DISCORD_BOT_TOKEN,
  totalShards
});

manager.on("shardCreate", shard => {
  console.log(`🧩 シャード ${shard.id} 起動`);
});

// ⭐ shard 状態取得（重要）
async function updateShardState() {
  try {
    const results = await manager.broadcastEval(client => ({
      shardId: client.shard.ids[0],
      ready: client.isReady(),
      ping: client.ws.ping,
      guilds: client.guilds.cache.size,
      uptime: client.uptime
    }));

    shardState.updatedAt = Date.now();
    shardState.shards = results;

  } catch (e) {
    console.error("❌ shard status fetch failed", e);
  }
}

manager.spawn().then(() => {
  updateShardState();
  setInterval(updateShardState, 60_000); // 1分で十分
});

setInterval(() => {
  const req = https.get("https://bot.sakurahp.f5.si/", res => {
    res.resume(); // データ捨てる（重要）
    console.log("[KeepAlive]", res.statusCode);
  });

  req.on("error", err => {
    console.error("[KeepAlive Error]", err.message);
  });

  req.setTimeout(5000, () => {
    req.destroy();
    console.error("[KeepAlive Timeout]");
  });
}, 120_000);
