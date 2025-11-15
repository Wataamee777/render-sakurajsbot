// db.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not set');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

/**
 * Helper wrappers for common operations used by bot.js
 * (keeps bot.js tidy and centralizes supabase usage)
 */

export async function upsertUser(discord_id, username) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ discord_id, username }, { onConflict: 'discord_id' });
  if (error) throw error;
  return data;
}

export async function insertUserIpIfNotExists(discord_id, ip_hash) {
  // check exists
  const { data: existing, error: e1 } = await supabase
    .from('user_ips')
    .select('discord_id')
    .eq('ip_hash', ip_hash)
    .maybeSingle();
  if (e1) throw e1;
  if (!existing) {
    const { error: e2 } = await supabase.from('user_ips').insert({ discord_id, ip_hash });
    if (e2) throw e2;
    return true;
  }
  return false;
}

export async function getUserIpOwner(ip_hash) {
  const { data, error } = await supabase
    .from('user_ips')
    .select('discord_id')
    .eq('ip_hash', ip_hash)
    .maybeSingle();
  if (error) throw error;
  return data?.discord_id ?? null;
}

export async function insertAuthLog(discord_id, event_type, detail) {
  const { error } = await supabase.from('auth_logs').insert({ discord_id, event_type, detail });
  if (error) throw error;
}

export async function getPinnedByChannel(channel_id) {
  const { data, error } = await supabase
    .from('pinned_messages')
    .select('*')
    .eq('channel_id', channel_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function insertPinned(channel_id, message_id, content, author_name) {
  const { error } = await supabase.from('pinned_messages').insert({
    channel_id,
    message_id,
    content,
    author_name
  });
  if (error) throw error;
}

export async function updatePinnedMessage(channel_id, message_id) {
  const { error } = await supabase
    .from('pinned_messages')
    .update({ message_id, updated_at: new Date().toISOString() })
    .eq('channel_id', channel_id);
  if (error) throw error;
}

export async function deletePinned(channel_id) {
  const { error } = await supabase.from('pinned_messages').delete().eq('channel_id', channel_id);
  if (error) throw error;
}
