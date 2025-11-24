import { supabase } from './db.js';

// --- XP/Level管理 ---
export async function addXP(userId, type, amount) {
  const column = type === 'text' ? 'textxp' : 'vcxp';
  const { data: existing } = await supabase
    .from('account')
    .select(column)
    .eq('userid', userId)
    .single();

  if (!existing) return 0;

  const newXP = existing[column] + amount;

  await supabase.from('account')
    .update({ [column]: newXP })
    .eq('userid', userId);

  return newXP;
}

export async function modifyXP(userId, type, amount, mode) {
  const delta = mode === 'add' ? amount : -amount;
  return addXP(userId, type, delta);
}

export function calculateLevel(xp) {
  return Math.floor(Math.sqrt(xp / 10));
}

export async function updateLevel(userId, type) {
  const columnXP = type === 'text' ? 'textxp' : 'vcxp';
  const columnLV = type === 'text' ? 'textlevel' : 'vclevel';

  const { data: existing } = await supabase
    .from('account')
    .select(columnXP)
    .eq('userid', userId)
    .single();

  if (!existing) return 0;

  const newLevel = calculateLevel(existing[columnXP]);

  await supabase.from('account')
    .update({ [columnLV]: newLevel })
    .eq('userid', userId);

  return newLevel;
}

export async function modifyLevel(userId, type, amount, mode) {
  const { data: existing } = await supabase
    .from('account')
    .select(type === 'text' ? 'textlevel' : 'vclevel')
    .eq('userid', userId)
    .single();

  if (!existing) return 0;

  const columnLV = type === 'text' ? 'textlevel' : 'vclevel';
  const newLV = mode === 'add' ? existing[columnLV] + amount : existing[columnLV] - amount;

  await supabase.from('account')
    .update({ [columnLV]: newLV })
    .eq('userid', userId);

  return newLV;
}

// --- XP付与 ---
export async function addTextXP(userId, amount = 1) {
  await addXP(userId, 'text', amount);
  return updateLevel(userId, 'text');
}

export async function addVCXP(userId, minutes) {
  const xp = Math.floor(minutes);
  await addXP(userId, 'vc', xp);
  return updateLevel(userId, 'vc');
}

// --- アカウント作成/削除 ---
export async function createAccount(userId) {
  const { data } = await supabase
    .from('account')
    .insert([{
      userid: userId,
      textxp: 0,
      vcxp: 0,
      textlevel: 0,
      vclevel: 0,
      contributor: false,
      mod: false
    }])
    .select()
    .single();
  return data;
}

export async function deleteAccount(userId) {
  const { error } = await supabase
    .from('account')
    .delete()
    .eq('userid', userId);
  return !error;
}

// --- アカウント移行 ---
export async function transferAccount(oldUserId, newUserId) {
  const { data } = await supabase
    .from('account')
    .select('*')
    .eq('userid', oldUserId)
    .single();

  if (!data) throw new Error('旧アカウントが存在しません');

  await supabase.from('account')
    .insert([{ ...data, userid: newUserId }]);

  await deleteAccount(oldUserId);
  return true;
}

// --- SNS設定 ---
export async function setSNS(userId, type, value, isPublic = true) {
  const column = `sns_${type}`;
  const publicColumn = `sns_${type}_public`;

  await supabase.from('account')
    .update({ [column]: value, [publicColumn]: isPublic })
    .eq('userid', userId);
}

// --- 取得 ---
export async function getAccount(userId) {
  const { data } = await supabase
    .from('account')
    .select('*')
    .eq('userid', userId)
    .single();
  return data;
}
