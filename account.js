// account.js
import { supabase } from "./db.js";

// ===============================
// アカウント取得
// ===============================
export async function getAccount(userId) {
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
export async function createAccount(userId) {
  const exists = await getAccount(userId);
  if (exists) return { error: "AccountAlreadyExists" };

  const { data, error } = await supabase
    .from("accounts")
    .insert({
      user_id: userId,
      xp: 0,
      vcxp: 0,
      level: 1,
      vclevel: 1,
      contributor: false,
      mod: false,
      sns: {}
    })
    .select()
    .single();

  return { data, error };
}


// ===============================
// アカウント削除
// ===============================
export async function deleteAccount(userId) {
  const { error } = await supabase
    .from("accounts")
    .delete()
    .eq("user_id", userId);

  return { error };
}


// ===============================
// アカウント移行（丸コピー → 旧削除）
// ===============================
export async function transferAccount(oldId, newId) {
  const oldAcc = await getAccount(oldId);
  if (!oldAcc) return { error: "OldAccountNotFound" };

  const existsNew = await getAccount(newId);
  if (existsNew) return { error: "NewAccountAlreadyExists" };

  const { error: insertError } = await supabase
    .from("accounts")
    .insert({
      user_id: newId,
      xp: oldAcc.xp,
      vcxp: oldAcc.vcxp,
      level: oldAcc.level,
      vclevel: oldAcc.vclevel,
      contributor: oldAcc.contributor,
      mod: oldAcc.mod,
      sns: oldAcc.sns
    });

  if (insertError) return { error: insertError };

  await deleteAccount(oldId);

  return { success: true };
}


// ===============================
// XP変更（add / delete）
// ===============================
export async function modifyXP(userId, type, value) {
  const account = await getAccount(userId);
  if (!account) return { error: "NotFound" };

  let newXP = account.xp;

  if (type === "add") newXP += value;
  else if (type === "delete") newXP -= value;

  if (newXP < 0) newXP = 0;

  const { error } = await supabase
    .from("accounts")
    .update({ xp: newXP })
    .eq("user_id", userId);

  return { error };
}


// ===============================
// Level変更（add / delete）
// ===============================
export async function modifyLevel(userId, type, value) {
  const account = await getAccount(userId);
  if (!account) return { error: "NotFound" };

  let newLevel = account.level;

  if (type === "add") newLevel += value;
  else if (type === "delete") newLevel -= value;

  if (newLevel < 1) newLevel = 1;

  const { error } = await supabase
    .from("accounts")
    .update({ level: newLevel })
    .eq("user_id", userId);

  return { error };
}


// ===============================
// SNS設定（sns.X = @id）
// ===============================
export async function setSNS(userId, type, value) {
  const account = await getAccount(userId);
  if (!account) return { error: "NotFound" };

  const sns = account.sns || {};
  sns[type] = value;

  const { error } = await supabase
    .from("accounts")
    .update({ sns })
    .eq("user_id", userId);

  return { error };
}

export async function addTextXP(userId, amount) {
  const account = await getAccount(userId);
  if (!account) return { error: "NotFound" };

  const newXP = account.textxp + amount;
  const { error } = await supabase
    .from("accounts")
    .update({ textxp: newXP })
    .eq("user_id", userId);

  return { error };
}

// ===============================
// VC XP追加（VC監視用）
// ===============================
export async function addVCXP(userId, amount) {
  const account = await getAccount(userId);
  if (!account) return { error: "NotFound" };

  const newXP = account.vcxp + amount;
  const { error } = await supabase
    .from("accounts")
    .update({ vcxp: newXP })
    .eq("user_id", userId);

  return { error };
}

export async function checkTextLevel(userId) {
  const account = await getAccount(userId);
  if (!account) return;

  let xp = account.xp;
  let level = account.level;

  let leveledUp = false;

  while (xp >= level * 100) {
    xp -= level * 100;
    level++;
    leveledUp = true;
  }

  if (leveledUp) {
    await supabase
      .from("accounts")
      .update({ xp, level })
      .eq("user_id", userId);

    return level;
  }

  return null;
}

export async function checkVCLevel(userId) {
  const account = await getAccount(userId);
  if (!account) return;

  let xp = account.vcxp;
  let level = account.vclevel;

  let leveledUp = false;

  while (xp >= level * 100) {
    xp -= level * 100;
    level++;
    leveledUp = true;
  }

  if (leveledUp) {
    await supabase
      .from("accounts")
      .update({ vcxp: xp, vclevel: level })
      .eq("user_id", userId);

    return level;
  }

  return null;
}
