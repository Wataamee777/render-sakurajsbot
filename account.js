import { supabase } from "./db.js";

// ===============================
// レベル計算
// ===============================
export function calculateUserLevel(totalExperience) {
    let level = Math.floor(totalExperience / 10);
    if (level > 100) level = 100;
    return level;
}

// ===============================
// ランダムXP生成
// ===============================
function generateRandomExperience(experienceType) {
    if (experienceType === "text") {
        return Math.floor(Math.random() * 5) + 1; // 1〜5
    }
    if (experienceType === "voice") {
        return Math.floor(Math.random() * 8) + 2; // 2〜9
    }
    return 0;
}

// ===============================
// ユーザーデータ取得
// ===============================
export async function fetchUserAccount(userId) {
    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("userid", userId)
        .single();

    if (error) return null;
    return data;
}

// ===============================
// アカウント作成（status: manual / bot / transfer）
// ===============================
export async function createUserAccount(userId, statusType = "bot") {
    const newUserData = {
        userid: userId,
        experience: 0,
        level: 0,
        status: statusType,
        created_at: new Date().toISOString()
    };

    const { error } = await supabase
        .from("users")
        .upsert(newUserData);

    return !error;
}

// ===============================
// アカウント削除
// ===============================
export async function deleteUserAccount(userId) {
    const { error } = await supabase
        .from("users")
        .delete()
        .eq("userid", userId);

    return !error;
}

// ===============================
// アカウント移行（old → new）
// ===============================
export async function transferUserAccount(oldUserId, newUserId) {
    const oldUserData = await fetchUserAccount(oldUserId);
    if (!oldUserData) return false;

    const transferData = {
        userid: newUserId,
        experience: oldUserData.experience,
        level: oldUserData.level,
        status: "transfer",
        created_at: oldUserData.created_at
    };

    // 新ID に移す
    const { error: updateError } = await supabase
        .from("users")
        .upsert(transferData);

    if (updateError) return false;

    // 旧データ削除
    await deleteUserAccount(oldUserId);

    return true;
}

// ===============================
// XP 加算（text / voice）
// ===============================
export async function addUserExperience(userId, experienceType) {
    const randomExperience = generateRandomExperience(experienceType);

    let userData = await fetchUserAccount(userId);

    // アカウント未作成 → 自動生成
    if (!userData) {
        await createUserAccount(userId, "bot");
        userData = await fetchUserAccount(userId);
    }

    const newExperience = userData.experience + randomExperience;
    const newLevel = calculateUserLevel(newExperience);

    const { error } = await supabase
        .from("users")
        .update({
            experience: newExperience,
            level: newLevel
        })
        .eq("userid", userId);

    return !error;
}
