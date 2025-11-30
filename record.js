// record.js
import {
  joinVoiceChannel,
} from "@discordjs/voice";
import fs from "fs";
import { pipeline } from "stream";
import path from "path";

// ← コード側で録音対象を固定
export const WHITELIST = [
  "917633605684056085"
];

const activeRecords = new Map();

export async function startRecord(interaction) {
  const member = interaction.member;

  if (!member.voice.channel)
    return interaction.editReply("VCに入ってないよ！");

  const vc = member.voice.channel;

  if (activeRecords.has(vc.id))
    return interaction.editReply("録音中だよ！");

  const connection = joinVoiceChannel({
    channelId: vc.id,
    guildId: vc.guild.id,
    adapterCreator: vc.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const receiver = connection.receiver;

  const recordData = {
    whitelist: WHITELIST,
    files: {},
    connection,
    receiver,
  };

  activeRecords.set(vc.id, recordData);

  // VC全体へ通知（規約のため必須）
  await vc.send(
    `🎙 **録音開始！**\n対象ユーザーID:\n${WHITELIST
      .map(id => `• <@${id}>`)
      .join("\n")}\nこのVCは録音されています。`
  );

  receiver.speaking.on("start", (userId) => {
    // ← ホワイトリスト以外は録音しない
    if (!recordData.whitelist.includes(userId)) return;

    const user = vc.guild.members.cache.get(userId);
    if (!user) return;

    if (!recordData.files[userId]) {
      const file = path.join(
        "./recordings",
        `${userId}-${Date.now()}.pcm`
      );
      recordData.files[userId] = fs.createWriteStream(file);
    }

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: "silence" },
    });

    pipeline(audioStream, recordData.files[userId], (err) => {
      if (err) console.log("録音エラー:", err);
    });
  });

  return interaction.editReply("録音開始したよ！");
}

export async function stopRecord(interaction) {
  const member = interaction.member;
  const vc = member.voice.channel;

  if (!vc) return interaction.editReply("VCに入ってない");

  const recordData = activeRecords.get(vc.id);

  if (!recordData)
    return interaction.editReply("録音してないよ");

  for (const ws of Object.values(recordData.files)) ws.end();

  recordData.connection.destroy();
  activeRecords.delete(vc.id);

  await interaction.editReply("録音終了！");
  await vc.send("🎙 **録音終了しました！**");
}
