import {
  joinVoiceChannel,
} from "@discordjs/voice";
import fs from "fs";
import { pipeline } from "stream";
import path from "path";

export const WHITELIST = ["917633605684056085"];

const activeRecords = new Map();

export async function startRecord(interaction) {
  await interaction.deferReply({ ephemeral: true });
  console.log("[DEBUG] deferReply OK");

  try {
    const member = interaction.member;

    if (!member.voice.channel)
      return interaction.editReply("VCに居ないよ！");

    const vc = member.voice.channel;

    if (activeRecords.has(vc.id))
      return interaction.editReply("もう録音してるよ！");

    // VC 接続
    let connection;
    try {
      connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guild.id,
        adapterCreator: vc.guild.voiceAdapterCreator,
        selfDeaf: false,
      });
    } catch (e) {
      console.error("VC接続エラー:", e);
      return interaction.editReply("VCに入れなかった…権限かbotの設定を確認して！");
    }

    const receiver = connection.receiver;

    const recordData = {
      whitelist: WHITELIST,
      files: {},
      connection,
      receiver,
    };

    activeRecords.set(vc.id, recordData);

    // VCへの録音通知（規約）
    await vc.send(
      `🎙 **録音開始！**\n対象ユーザー:\n${WHITELIST.map(id => `• <@${id}>`).join("\n")}\nこのVCは録音されています。`
    );

    receiver.speaking.on("start", (userId) => {
      try {
        if (!recordData.whitelist.includes(userId)) return;

        const user = vc.guild.members.cache.get(userId);
        if (!user) return;

        if (!recordData.files[userId]) {
          const filePath = path.join(
            "./recordings",
            `${userId}-${Date.now()}.pcm`
          );

          recordData.files[userId] = fs.createWriteStream(filePath);
        }

        const audioStream = receiver.subscribe(userId, {
          end: { behavior: "silence" },
        });

        pipeline(audioStream, recordData.files[userId], (err) => {
          if (err) console.error("録音パイプエラー:", err);
        });

      } catch (err) {
        console.error("speakingイベント内エラー:", err);
      }
    });

    return interaction.editReply("録音を開始したよ！");

  } catch (err) {
    console.error("startRecordエラー:", err);

    if (interaction.replied || interaction.deferred)
      return interaction.editReply("録音開始中にエラーが発生したよ…");

    return interaction.reply({
      content: "録音開始中にエラーが発生したよ…",
      ephemeral: true,
    });
  }
}

export async function stopRecord(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const member = interaction.member;
    const vc = member.voice.channel;

    if (!vc) return interaction.editReply("VCに居ないよ");

    const recordData = activeRecords.get(vc.id);
    if (!recordData)
      return interaction.editReply("録音してないよ");

    for (const ws of Object.values(recordData.files)) {
      try {
        ws.end();
      } catch (e) {
        console.error("ファイルクローズエラー:", e);
      }
    }

    try {
      recordData.connection.destroy();
    } catch (e) {
      console.error("VC切断エラー:", e);
    }

    activeRecords.delete(vc.id);

    await interaction.editReply("録音停止したよ！");
    await vc.send("🎙 **録音終了しました！**");

  } catch (err) {
    console.error("stopRecordエラー:", err);

    if (interaction.replied || interaction.deferred)
      return interaction.editReply("録音停止中にエラーが発生したよ…");

    return interaction.reply({
      content: "録音停止中にエラーが発生したよ…",
      ephemeral: true,
    });
  }
}
