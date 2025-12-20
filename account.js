// accounts.js
import { supabase } from "./db.js";

// ===============================
// レベル計算
// ===============================
export function calculateUserLevel(totalXp) {
    let level = Math.floor(totalXp / 10);
    if (level > 100) level = 100;
    return level;
}

// ===============================
// ランダムXP生成
// ===============================
function generateRandomExperience(type) {
    if (type === "text") return Math.floor(Math.random() * 5) + 1;  // 1-5
    if (type === "voice") return Math.floor(Math.random() * 8) + 2; // 2-9
    return 0;
}

// ===============================
// ユーザーデータ取得
// ===============================
export async function fetchUserAccount(userId) {
    const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", userId)
        .single();

    if (error) return null;
    return data;
}

// ===============================
// アカウント作成
// ===============================
export async function createUserAccount(userId) {
    const newUser = {
        user_id: userId,
        text_xp: 0,
        text_level: 0,
        voice_xp: 0,
        voice_level: 0,
        last_voice_xp_at: null
    };

    try {
        const { error } = await supabase
            .from("accounts")
            .upsert(newUser)
            .select(); // 挿入されたレコードを返す場合は.select()を追加

        if (error) {
            // 💡 データベースレベルのエラーをコンソールに出力
            console.error("Supabase insert error:", error);
            // データベースへの挿入が失敗した場合
            return false;
        }

        return true; // 成功
    } catch (e) {
        // 💡 実行時エラーやネットワークエラーをコンソールに出力
        console.error("Execution error creating user account:", e);
        // 予期せぬエラーが発生した場合
        return false;
    }
}
// ===============================
// アカウント削除
// ===============================
export async function deleteUserAccount(userId) {
    const { error } = await supabase
        .from("accounts")
        .delete()
        .eq("user_id", userId);

    return !error;
}

// ===============================
// データ移行（old → new）
// ===============================
export async function transferUserAccount(oldId, newId) {
    const oldData = await fetchUserAccount(oldId);
    if (!oldData) return false;

    const newData = {
        user_id: newId,
        text_xp: oldData.text_xp,
        text_level: oldData.text_level,
        voice_xp: oldData.voice_xp,
        voice_level: oldData.voice_level,
        last_voice_xp_at: oldData.last_voice_xp_at
    };

    // 新IDに上書き
    const { error: upErr } = await supabase
        .from("accounts")
        .upsert(newData);

    if (upErr) return false;

    // 古いID削除
    await deleteUserAccount(oldId);

    return true;
}

// ===============================
// XP 加算（text / voice）
// ===============================
export async function addUserExperience(userId, type) {
    let user = await fetchUserAccount(userId);

    // データなかったら自動作成
    if (!user) {
        await createUserAccount(userId);
        user = await fetchUserAccount(userId);
    }

    const xpField = type === "text" ? "text_xp" : "voice_xp";
    const levelField = type === "text" ? "text_level" : "voice_level";

    const addXp = generateRandomExperience(type);
    const newXp = user[xpField] + addXp;
    const newLevel = calculateUserLevel(newXp);

    const updateData = {
        [xpField]: newXp,
        [levelField]: newLevel
    };

    if (type === "voice") {
        updateData.last_voice_xp_at = new Date().toISOString();
    }

    const { error } = await supabase
        .from("accounts")
        .update(updateData)
        .eq("user_id", userId);

    return !error;
}
