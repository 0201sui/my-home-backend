require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ===== 存储层 =====
const useSupabase = !!process.env.SUPABASE_URL;
let supabase = null;
if (useSupabase) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

const mem = {
  sessions: [],
  messages: [],
  memories: [],
  readings: {},
  settings: null,
  stickers: [],
  profile: { userBio: '', aiBio: '', userName: '我', aiName: 'AI', nickname: '', petImage: '', petImages: [] },
  _id: 1
};
function nextId() { const id = String(mem._id++); scheduleSave(); return id; }

// ===== 文件持久化（重启后端也不丢聊天记录/记忆/设置，根治 AI 失忆）=====
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        sessions: mem.sessions,
        messages: mem.messages,
        memories: mem.memories,
        readings: mem.readings,
        settings: mem.settings,
        stickers: mem.stickers,
        profile: mem.profile,
        _id: mem._id
      }));
    } catch (e) { console.error('保存状态失败:', e.message); }
  }, 250);
}
function saveState() { scheduleSave(); }
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      mem.sessions = raw.sessions || [];
      mem.messages = raw.messages || [];
      mem.memories = raw.memories || [];
      mem.readings = raw.readings || {};
      mem.settings = raw.settings || null;
      mem.stickers = raw.stickers || [];
      mem.profile = raw.profile || mem.profile;
      mem._id = raw._id || 1;
      // 一次性迁移：旧默认昵称「裴拟」或「ClaudeAI」统一改为用户指定的「AI」
      if (mem.profile && (mem.profile.aiName === '裴拟' || mem.profile.aiName === 'ClaudeAI' || !mem.profile.aiName)) {
        mem.profile.aiName = 'AI';
        scheduleSave();
      }
      console.log('已从本地文件恢复状态：', mem.messages.length, '条消息 /', mem.memories.length, '条记忆');
    }
  } catch (e) { console.error('加载状态失败:', e.message); }
}

// 生成被引用消息的可读预览（用于引用条显示）
function quotedPreviewOf(m) {
  if (!m) return '';
  if (m.voice) return '[语音消息]';
  if (m.images && m.images.length > 0) return `[图片×${m.images.length}]`;
  if (m.content && m.content.includes('[贴纸]')) return '[贴纸]';
  return (m.content || '').trim();
}

// 统一按 id 查找消息（兼容 Supabase / 内存两种存储）
async function getMessageById(id) {
  if (!id) return null;
  if (useSupabase && supabase) {
    try {
      const { data, error } = await supabase.from('messages').select('*').eq('id', String(id)).maybeSingle();
      if (!error && data) return data;
    } catch (e) { console.error('supabase 查询引用消息失败:', e); }
  }
  return mem.messages.find(m => String(m.id) === String(id)) || null;
}

// 智能分条：优先按空行分；长文无空行时按单换行分（合并过短续行）；超长无换行时按标点切成多段
function splitReplies(text) {
  const t = (text || '').trim();
  if (!t) return [''];
  // 1) 显式空行分隔：永远分条（AI 明确想分多条消息）
  let parts = t.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) return parts;
  // 2) 单换行 + 较长：按单换行分，合并过短续行
  if (t.includes('\n') && t.length >= 40) {
    const s = t.split(/\n+/).map(p => p.trim()).filter(Boolean);
    parts = [];
    for (const p of s) {
      if (parts.length && p.length < 14) parts[parts.length - 1] += '\n' + p;
      else parts.push(p);
    }
    if (parts.length > 1) return parts;
  }
  // 3) 不再强制按标点切碎：单段长文保持为一条气泡（AI 已被告知用空行/换行来表达"多条短消息"），
  //    避免"先全部生成再被自动拆成好几段"的割裂感。
  return [t];
}

const defaultSettings = {
  system_prompt: '',
  temperature: 0.7,
  max_context_rounds: 250,
  compress_threshold: 4000,
  compress_keep_rounds: 15,
  max_reply_tokens: 4096,
  auto_summarize: true,
  auto_summarize_after: 50,
  delete_after_summarize: false
};

// ===== 健康检查 =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '裴拟的海洋馆后端正常运行', storage: useSupabase ? 'supabase' : 'memory' });
});

// ===== API 代理（给 ApiConfig.jsx 用）=====

app.post('/test', async (req, res) => {
  const { base_url, api_key, model } = req.body;
  try {
    const url = base_url.replace(/\/$/, '') + '/v1/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages: [{ role: 'user', content: '请回复"连接成功"四个字' }],
        max_tokens: 20, temperature: 0
      })
    });
    const data = await resp.json();
    if (!resp.ok) return res.json({ success: false, error: data.error?.message || 'API返回错误' });
    const reply = data.choices?.[0]?.message?.content || '无回复';
    res.json({ success: true, reply });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/fetch-models', async (req, res) => {
  const { base_url, api_key } = req.body;
  try {
    const url = base_url.replace(/\/$/, '') + '/v1/models';
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${api_key}` } });
    const data = await resp.json();
    const models = (data.data || []).map(m => m.id);
    res.json({ success: true, models });
  } catch (err) {
    res.json({ success: false, error: '拉取失败: ' + err.message });
  }
});

// ===== 会话管理 =====
app.get('/sessions', async (req, res) => {
  try {
    if (useSupabase) {
      const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
      if (error) throw error;
      res.json({ sessions: data });
    } else {
      res.json({ sessions: [...mem.sessions].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)) });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    const now = new Date().toISOString();
    if (useSupabase) {
      const { data, error } = await supabase.from('sessions').insert({ name: name || '新对话', created_at: now, updated_at: now }).select().single();
      if (error) throw error;
      res.json({ session: data });
    } else {
      const session = { id: nextId(), name: name || '新对话', created_at: now, updated_at: now };
      mem.sessions.push(session);
      res.json({ session });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (useSupabase) {
      const { data, error } = await supabase.from('sessions').update({ name, updated_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) throw error;
      res.json({ session: data });
    } else {
      const s = mem.sessions.find(s => s.id === id);
      if (s) { s.name = name; s.updated_at = new Date().toISOString(); }
      saveState();
      res.json({ session: s });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (useSupabase) {
      await supabase.from('messages').delete().eq('session_id', id);
      await supabase.from('sessions').delete().eq('id', id);
    } else {
      mem.sessions = mem.sessions.filter(s => s.id !== id);
      mem.messages = mem.messages.filter(m => m.session_id !== id);
      saveState();
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 消息管理 =====
app.get('/sessions/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    if (useSupabase) {
      const { data, error } = await supabase.from('messages').select('*').eq('session_id', id).eq('visible', true).order('created_at', { ascending: true });
      if (error) throw error;
      res.json({ messages: data });
    } else {
      res.json({ messages: mem.messages.filter(m => m.session_id === id && m.visible).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)) });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (useSupabase) {
      const { data, error } = await supabase.from('messages').update({ content, edited: true }).eq('id', id).select().single();
      if (error) throw error;
      res.json({ message: data });
    } else {
      const msg = mem.messages.find(m => m.id === id);
      if (msg) { msg.content = content; msg.edited = true; }
      saveState();
      res.json({ message: msg });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (useSupabase) {
      const { data: all } = await supabase.from('messages').select('id, role, session_id, created_at');
      const target = (all || []).find(m => m.id === id);
      if (target && target.role === 'user') {
        const targetTime = new Date(target.created_at);
        const idsToDelete = new Set([id]);
        (all || []).forEach(m => {
          if (m.session_id === target.session_id && m.role === 'assistant' && new Date(m.created_at) > targetTime) {
            idsToDelete.add(m.id);
          }
        });
        if (idsToDelete.size > 0) await supabase.from('messages').delete().in('id', Array.from(idsToDelete));
      } else {
        await supabase.from('messages').delete().eq('id', id);
      }
    } else {
      const target = mem.messages.find(m => m.id === id);
      if (target && target.role === 'user') {
        const targetTime = new Date(target.created_at);
        const idsToDelete = new Set([id]);
        mem.messages.forEach(m => {
          if (m.session_id === target.session_id && m.role === 'assistant' && new Date(m.created_at) > targetTime) {
            idsToDelete.add(m.id);
          }
        });
        mem.messages = mem.messages.filter(m => !idsToDelete.has(m.id));
      } else {
        mem.messages = mem.messages.filter(m => m.id !== id);
      }
    }
    saveState();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 记忆管理 =====
app.get('/memories', async (req, res) => {
  try {
    const { keyword } = req.query;
    let memories;
    if (useSupabase) {
      let q = supabase.from('memories').select('*').order('timestamp', { ascending: false });
      if (keyword) q = q.contains('keywords', [keyword]);
      const { data, error } = await q;
      if (error) throw error;
      memories = data || [];
    } else {
      memories = [...mem.memories].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      if (keyword) memories = memories.filter(m => m.keywords?.includes(keyword));
    }
    res.json({ success: true, data: memories });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/memories/keywords', async (req, res) => {
  try {
    let memories = useSupabase
      ? (await supabase.from('memories').select('keywords')).data || []
      : mem.memories;
    const kwMap = {};
    memories.forEach(m => {
      (m.keywords || []).forEach(k => { kwMap[k] = (kwMap[k] || 0) + 1; });
    });
    const keywords = Object.entries(kwMap).map(([keyword, count]) => ({ keyword, count })).sort((a, b) => b.count - a.count);
    res.json({ success: true, data: keywords });
  } catch (err) { res.json({ success: true, data: [] }); }
});

app.get('/memories/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    let memories = useSupabase
      ? (await supabase.from('memories').select('*').order('timestamp', { ascending: false })).data || []
      : [...mem.memories].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const filtered = memories.filter(m =>
      (m.summary || '').toLowerCase().includes(q) ||
      (m.title || '').toLowerCase().includes(q) ||
      (m.keywords || []).some(k => k.toLowerCase().includes(q))
    );
    res.json({ success: true, data: filtered });
  } catch (err) { res.json({ success: true, data: [] }); }
});

app.post('/memories', async (req, res) => {
  try {
    const { title, summary, keywords } = req.body;
    const memory = {
      title: title || '',
      summary,
      keywords: keywords || [],
      timestamp: new Date().toISOString(),
      conversation_id: 'manual'
    };
    if (useSupabase) {
      const { data, error } = await supabase.from('memories').insert(memory).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } else {
      memory.id = nextId();
      mem.memories.push(memory);
      res.json({ success: true, data: memory });
    }
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, summary, keywords } = req.body;
    const updates = { title, summary, keywords };
    if (useSupabase) {
      const { data, error } = await supabase.from('memories').update(updates).eq('id', id).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } else {
      const m = mem.memories.find(m => m.id === id);
      if (m) Object.assign(m, updates);
      saveState();
      res.json({ success: true, data: m });
    }
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (useSupabase) { await supabase.from('memories').delete().eq('id', id); }
      else { mem.memories = mem.memories.filter(m => m.id !== id); }
      saveState();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/memories/compress/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { max_words, delete_after } = req.body;
    let allMessages = [];
    if (useSupabase) {
      const { data } = await supabase.from('messages').select('id, role, content, created_at').eq('session_id', sessionId).eq('visible', true).order('created_at', { ascending: true });
      allMessages = (data || []).filter(m => !m.summarized);
    } else {
      allMessages = mem.messages.filter(m => m.session_id === sessionId && m.visible && !m.summarized).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    if (allMessages.length === 0) return res.json({ success: false, error: '没有需要总结的新消息' });

    const content = allMessages.map(m => `${m.role}: ${m.content}`).join('\n');
    const summary = await callCompressModel(content, max_words || 380);
    if (!summary) return res.json({ success: false, error: '总结失败' });

    // 提取关键词
    const kwMatch = summary.match(/关键词[：:]\s*(.+)/);
    const keywords = kwMatch ? kwMatch[1].split(/[，,、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5) : [];

    const memory = {
      title: `对话总结 ${new Date().toLocaleString('zh-CN')}`,
      summary,
      keywords,
      timestamp: new Date().toISOString(),
      conversation_id: sessionId.toString()
    };
    if (useSupabase) {
      const { data, error } = await supabase.from('memories').insert(memory).select().single();
      if (error) throw error;
      const ids = allMessages.map(m => m.id);
      if (delete_after) { await supabase.from('messages').delete().in('id', ids); }
      else { await supabase.from('messages').update({ summarized: true }).in('id', ids); }
      res.json({ success: true, data, message_count: allMessages.length, deleted: delete_after });
    } else {
      memory.id = nextId();
      mem.memories.push(memory);
      const ids = new Set(allMessages.map(m => m.id));
      if (delete_after) { mem.messages = mem.messages.filter(m => !ids.has(m.id)); }
      else { mem.messages.forEach(m => { if (ids.has(m.id)) m.summarized = true; }); }
      saveState();
      res.json({ success: true, data: memory, message_count: allMessages.length, deleted: delete_after });
    }
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/memories/delete-source/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let memory;
    if (useSupabase) {
      const { data } = await supabase.from('memories').select('conversation_id').eq('id', id).single();
      memory = data;
    } else {
      memory = mem.memories.find(m => m.id === id);
    }
    if (!memory) return res.json({ success: false, error: '记忆不存在' });
    const sessionId = memory.conversation_id;
    if (sessionId === 'manual') return res.json({ success: false, error: '手动添加的记忆没有原始记录' });

    let deleted = 0;
    if (useSupabase) {
      const { data } = await supabase.from('messages').select('id').eq('session_id', sessionId).eq('summarized', true);
      deleted = data?.length || 0;
      await supabase.from('messages').delete().eq('session_id', sessionId).eq('summarized', true);
    } else {
      const toDelete = mem.messages.filter(m => m.session_id === sessionId && m.summarized);
      deleted = toDelete.length;
      mem.messages = mem.messages.filter(m => !(m.session_id === sessionId && m.summarized));
    }
    res.json({ success: true, deleted_count: deleted });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/memories/merge', async (req, res) => {
  try {
    const { memory_ids, max_words } = req.body;
    let memories;
    if (useSupabase) {
      const { data } = await supabase.from('memories').select('*').in('id', memory_ids);
      memories = data || [];
    } else {
      memories = mem.memories.filter(m => memory_ids.includes(m.id));
    }
    if (memories.length < 2) return res.json({ success: false, error: '至少需要2条记忆' });

    const content = memories.map(m => `${m.title || '无标题'}: ${m.summary}`).join('\n');
    const summary = await callCompressModel('请合并以下记忆，保留关键信息：\n' + content, max_words || 200);
    const allKeywords = [...new Set(memories.flatMap(m => m.keywords || []))];

    const newMemory = {
      title: `合并记忆 ${new Date().toLocaleString('zh-CN')}`,
      summary, keywords: allKeywords,
      timestamp: new Date().toISOString(),
      conversation_id: 'merged'
    };
    if (useSupabase) {
      const { data, error } = await supabase.from('memories').insert(newMemory).select().single();
      if (error) throw error;
      await supabase.from('memories').delete().in('id', memory_ids);
      res.json({ success: true, data });
    } else {
      newMemory.id = nextId();
      mem.memories.push(newMemory);
      mem.memories = mem.memories.filter(m => !memory_ids.includes(m.id));
      res.json({ success: true, data: newMemory });
    }
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ===== 导入导出 =====
app.get('/export/chat/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let session, messages;
    if (useSupabase) {
      const { data: s } = await supabase.from('sessions').select('*').eq('id', id).single();
      const { data: msgs } = await supabase.from('messages').select('*').eq('session_id', id).order('created_at', { ascending: true });
      session = s; messages = msgs || [];
    } else {
      session = mem.sessions.find(s => s.id === id);
      messages = mem.messages.filter(m => m.session_id === id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    res.json({ success: true, data: { session, messages } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/import/chat', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();
    const name = (data.session?.name || '导入的对话') + ' (导入)';
    let newId;
    if (useSupabase) {
      const { data: newSession, error } = await supabase.from('sessions').insert({ name, created_at: now, updated_at: now }).select().single();
      if (error) throw error;
      newId = newSession.id;
      const inserts = (data.messages || []).map(m => ({ session_id: newId, role: m.role, content: m.content, visible: true, created_at: m.created_at || now }));
      await supabase.from('messages').insert(inserts);
    } else {
      const newSession = { id: nextId(), name, created_at: now, updated_at: now };
      mem.sessions.push(newSession);
      newId = newSession.id;
      (data.messages || []).forEach(m => {
        mem.messages.push({ id: nextId(), session_id: newId, role: m.role, content: m.content, visible: true, created_at: m.created_at || now });
      });
    }
    res.json({ success: true, imported_count: (data.messages || []).length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/export/memories', async (req, res) => {
  try {
    let memories = useSupabase
      ? (await supabase.from('memories').select('*').order('timestamp', { ascending: false })).data || []
      : mem.memories;
    res.json({ success: true, data: { memories } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/import/memories', async (req, res) => {
  try {
    const { memories } = req.body;
    let count = 0;
    if (useSupabase) {
      const inserts = memories.map(m => ({ title: m.title || '', summary: m.summary, keywords: m.keywords || [], timestamp: m.timestamp || new Date().toISOString(), conversation_id: m.conversation_id || 'imported' }));
      const { data, error } = await supabase.from('memories').insert(inserts).select();
      if (error) throw error;
      count = data?.length || 0;
    } else {
      memories.forEach(m => { mem.memories.push({ ...m, id: nextId() }); count++; });
    }
    res.json({ success: true, imported_count: count });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ===== 用户/AI 简介 =====
app.get('/profile', (req, res) => {
  res.json({ success: true, data: mem.profile });
});

app.put('/profile', (req, res) => {
      mem.profile = { ...mem.profile, ...req.body };
      saveState();
      res.json({ success: true, data: mem.profile });
});

// ===== 表情包 =====
app.get('/stickers', (req, res) => {
  res.json({ success: true, data: mem.stickers });
});

app.post('/stickers', (req, res) => {
  const body = req.body || {};
  // 兼容：{ urls: [...] } 或 { stickers: [{id,url,meaning,category}] }
  let incoming = [];
  if (Array.isArray(body.urls)) {
    incoming = body.urls.map(url => ({ id: String(nextId()), url, meaning: '', category: '默认', createdAt: new Date().toISOString() }));
  } else if (Array.isArray(body.stickers)) {
    incoming = body.stickers.map(s => ({ id: String(s.id || nextId()), url: s.url, meaning: s.meaning || '', category: s.category || '默认', createdAt: s.createdAt || new Date().toISOString() }));
  } else {
    return res.status(400).json({ success: false, error: 'urls 或 stickers 必须是数组' });
  }
  mem.stickers.push(...incoming);
  res.json({ success: true, data: incoming });
});

app.delete('/stickers/:id', (req, res) => {
  const { id } = req.params;
      mem.stickers = mem.stickers.filter(s => s.id !== id);
      saveState();
      res.json({ success: true });
});

// ===== 设置 =====
app.get('/settings', (req, res) => {
  try {
    if (useSupabase) {
      supabase.from('settings').select('*').limit(1).single().then(({ data, error }) => {
        if (error && error.code === 'PGRST116') return res.json({ settings: defaultSettings });
        if (error) throw error;
        res.json({ settings: data });
      });
    } else {
      res.json({ settings: mem.settings || defaultSettings });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/settings', (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    if (useSupabase) {
      supabase.from('settings').select('id').limit(1).single().then(async ({ data: existing }) => {
        if (existing) {
          const { data, error } = await supabase.from('settings').update(updates).eq('id', existing.id).select().single();
          if (error) throw error;
          res.json({ settings: data });
        } else {
          const { data, error } = await supabase.from('settings').insert(updates).select().single();
          if (error) throw error;
          res.json({ settings: data });
        }
      });
    } else {
      mem.settings = { ...(mem.settings || defaultSettings), ...updates };
      saveState();
      res.json({ settings: mem.settings });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 核心对话 =====
app.post('/chat', async (req, res) => {
  const { message, session_id, model, reply_to, stickers, api_url, api_key, api_model, images, tts_config } = req.body;
  if (!message && (!images || images.length === 0)) return res.status(400).json({ error: '消息不能为空' });
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  try {
    const now = new Date();
    const resolvedModel = (model === 'deepseek') ? 'deepseek-chat' : (model === 'gemini') ? '[个人次cli]gemini-3-pro-preview' : (api_model || '[特价MAX-CC]claude-sonnet-5');
    let settings = { ...defaultSettings };
    if (mem.settings) settings = mem.settings;

    // 引用消息查找（让 AI 真正"看到"被引用的内容）
    const quotedMsg = reply_to ? await getMessageById(reply_to) : null;
    const quotedPreview = quotedMsg ? quotedPreviewOf(quotedMsg) : null;

    // 保存用户消息（含图片 + 引用信息）
    const userMsg = {
      id: nextId(), session_id, role: 'user', content: message || '',
      images: images || [], visible: true, created_at: now.toISOString(),
      reply_to: reply_to || null,
      reply_role: quotedMsg ? quotedMsg.role : null,
      reply_content: quotedPreview,
      summarized: false
    };
    mem.messages.push(userMsg);
    const s = mem.sessions.find(s => s.id === session_id);
    if (s) s.updated_at = now.toISOString();

    // 加载历史（文本 + 图片标记）
    const history = mem.messages.filter(m => m.session_id === session_id && m.visible).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(m => {
      let content = m.content || '';
      if (m.images && m.images.length > 0) {
        content = content + (content ? '\n' : '') + `[用户发送了${m.images.length}张图片]`;
      }
      return { role: m.role, content, id: m.id };
    });
    const maxRounds = 999999; // 不限制上下文轮数，防止AI失忆
    const recentHistory = history.slice(-maxRounds);

    // 精简系统提示词（与 buildChatContext 一致，控制长度避免 AI 失忆）
    let sysContent = composeSystemPrompt(session_id, req.body.music_info, req.body.sticker_meanings || [], req.body.pet_images);

    const contextMessages = [{ role: 'system', content: sysContent.trim() }, ...recentHistory];

    // 如果当前消息有图片，用多模态格式替换最后一条用户消息
    if (images && images.length > 0 && contextMessages.length > 0) {
      const lastIdx = contextMessages.length - 1;
      const lastMsg = contextMessages[lastIdx];
      if (lastMsg && lastMsg.role === 'user') {
        const parts = [];
        if (message) parts.push({ type: 'text', text: message });
        images.forEach(img => parts.push({ type: 'image_url', image_url: { url: img } }));
        contextMessages[lastIdx] = { role: 'user', content: parts };
      }
    }

    // 把用户引用的消息内容注入到上下文，确保 AI 真正"看到"
    if (quotedMsg) {
      const roleName = quotedMsg.role === 'user' ? (mem.profile.userName || '用户') : (mem.profile.aiName || '裴拟');
      for (let i = contextMessages.length - 1; i >= 0; i--) {
        if (contextMessages[i].role === 'user') {
          const quoteText = quotedPreviewOf(quotedMsg);
          const base = (typeof contextMessages[i].content === 'string') ? contextMessages[i].content : (message || '');
          contextMessages[i] = { role: 'user', content: `(引用了「${roleName}」的消息：「${quoteText}」)\n\n${base}` };
          break;
        }
      }
    }

    // 调用模型
    const customConfig = (api_url && api_key) ? { api_url, api_key, api_model } : null;
    const { content: aiResponse, usage } = await callModel(contextMessages, model, settings, customConfig);

    // 智能分条：AI 用空行分隔；长文无空行时按单换行分条（合并过短续行）
    const replies = splitReplies(aiResponse);

    // 保存每条 AI 回复（检测 [voice] 语音标记 与 [quote] 引用标记）
    const savedReplies = [];
    for (let i = 0; i < replies.length; i++) {
      const replyTime = new Date().toISOString();
      let part = replies[i];

      // 解析 AI 的引用标记
      let replyRole = null, replyContent = null, replyQuoteMsgId = null;
      const quoteMatch = part.match(/\[quote\]([\s\S]*?)\[\/quote\]/);
      if (quoteMatch) {
        replyContent = quoteMatch[1].trim();
        replyRole = 'user';
        // 反查被引用的原消息 id（供前端隐藏其时间戳）
        const qm = history.find(h => h.role === 'user' && (h.content || '').includes(replyContent));
        replyQuoteMsgId = qm ? qm.id : null;
        part = part.replace(/\[quote\][\s\S]*?\[\/quote\]/, '').trim();
      }

      const voiceMatch = part.match(/\[voice\]([\s\S]*?)\[\/voice\]/);
      if (voiceMatch) {
        const voiceText = voiceMatch[1].trim();
        const remainingContent = part.replace(/\[voice\][\s\S]*?\[\/voice\]/, '').trim();

        // 始终生成语音对象（无 key 时 audio 为 null，前端仍显示语音条+文字）
        const voiceData = { text: voiceText, duration: Math.max(1, Math.ceil(voiceText.length / 4)) };
        if (tts_config && tts_config.apiKey) {
          try {
            voiceData.audio = await generateTTS(voiceText, tts_config);
          } catch (err) { console.error('TTS失败:', err.message); }
        }

        const msgContent = voiceData.audio ? remainingContent : '';
        mem.messages.push({ id: nextId(), session_id, role: 'assistant', content: msgContent, voice: voiceData, reply_role: replyRole, reply_content: replyContent, reply_to: replyQuoteMsgId, visible: true, created_at: replyTime, summarized: false });
        const replyObj = { content: msgContent, created_at: replyTime, voice: voiceData };
        if (replyRole) { replyObj.reply_role = replyRole; replyObj.reply_content = replyContent; }
        if (replyQuoteMsgId) replyObj.reply_to = replyQuoteMsgId;
        savedReplies.push(replyObj);
      } else {
        mem.messages.push({ id: nextId(), session_id, role: 'assistant', content: part, reply_role: replyRole, reply_content: replyContent, reply_to: replyQuoteMsgId, visible: true, created_at: replyTime, summarized: false });
        const replyObj = { content: part, created_at: replyTime };
        if (replyRole) { replyObj.reply_role = replyRole; replyObj.reply_content = replyContent; }
        if (replyQuoteMsgId) replyObj.reply_to = replyQuoteMsgId;
        savedReplies.push(replyObj);
      }
    }

    // 自动总结
    if (settings.auto_summarize) {
      const unsummarized = mem.messages.filter(m => m.session_id === session_id && m.visible && !m.summarized);
      if (unsummarized.length >= (settings.auto_summarize_after || 10) * 2) {
        await autoCompress(session_id, settings);
      }
    }

    res.json({ replies: savedReplies, usage: usage || null });
  } catch (error) {
    console.error('对话错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== TTS 语音合成（MiniMax）=====
app.post('/tts', async (req, res) => {
  const { text, api_key, voice_id, group_id, speed, model: ttsModel } = req.body;
  if (!text) return res.status(400).json({ error: '文本不能为空' });
  if (!api_key) return res.status(400).json({ error: '需要 MiniMax API Key' });

  try {
    const voiceSetting = {
      voice_id: voice_id || 'male-qn-qingse',
      speed: parseFloat(speed) || 1.0,
      vol: 1.0,
      pitch: 0
    };
    if (group_id && String(group_id).trim()) voiceSetting.group_id = String(group_id).trim();

    const resp = await fetch('https://api.minimax.chat/v1/t2a_v2', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ttsModel || 'speech-02-hd',
        text,
        stream: false,
        voice_setting: voiceSetting,
        audio_setting: { sample_rate: 32000, bit_rate: 128000, format: 'mp3', channel: 1 }
      })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: data.message || data.base_resp?.status_msg || 'TTS调用失败' });

    const audioHex = data.data?.audio;
    if (!audioHex) return res.status(500).json({ error: '未返回音频数据' });

    const audioBuffer = Buffer.from(audioHex, 'hex');
    res.set('Content-Type', 'audio/mp3');
    res.send(audioBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== TTS 语音合成辅助函数 =====
async function generateTTS(text, ttsConfig) {
  const voiceSetting = {
    voice_id: ttsConfig.voiceId || ttsConfig.customVoiceId || 'male-qn-qingse',
    speed: parseFloat(ttsConfig.speed) || 1.0,
    vol: 1.0,
    pitch: 0
  };
  if (ttsConfig.groupId && String(ttsConfig.groupId).trim()) {
    voiceSetting.group_id = String(ttsConfig.groupId).trim();
  }

  const resp = await fetch('https://api.minimax.chat/v1/t2a_v2', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ttsConfig.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ttsConfig.model || 'speech-02-hd',
      text, stream: false,
      voice_setting: voiceSetting,
      audio_setting: { sample_rate: 32000, bit_rate: 128000, format: 'mp3', channel: 1 }
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || data.base_resp?.status_msg || 'TTS调用失败');
  const audioHex = data.data?.audio;
  if (!audioHex) throw new Error('未返回音频数据');
  return Buffer.from(audioHex, 'hex').toString('base64');
}

// ===== 模型调用 =====
async function callModel(messages, modelName, settings, customConfig) {
  let apiUrl, apiKey, modelId;

  // 优先使用前端传过来的自定义 API 配置
  if (customConfig && customConfig.api_url && customConfig.api_key) {
    apiUrl = customConfig.api_url.replace(/\/$/, '') + '/v1/chat/completions';
    apiKey = customConfig.api_key;
    modelId = customConfig.api_model || modelName;
  } else if (modelName === 'deepseek') {
    apiUrl = 'https://api.deepseek.com/v1/chat/completions';
    apiKey = process.env.DEEPSEEK_API_KEY;
    modelId = 'deepseek-chat';
  } else if (modelName === 'gemini') {
    apiUrl = 'https://xn--vduyey89e.com/v1/chat/completions';
    apiKey = process.env.CLAUDE_API_KEY;
    modelId = '[个人次cli]gemini-3-pro-preview';
  } else {
    apiUrl = 'https://xn--vduyey89e.com/v1/chat/completions';
    apiKey = process.env.CLAUDE_API_KEY;
    modelId = '[特价MAX-CC]claude-sonnet-5';
  }

  if (!apiKey) throw new Error('API Key 未配置，请在API配置中设置');

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: false,
      max_tokens: settings.max_reply_tokens || 4096,
      temperature: settings.temperature ?? 0.7
    })
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || 'AI调用失败');
  const content = data.choices?.[0]?.message?.content || '无回复';
  const usage = data.usage || null;
  return { content, usage };
}

// ===== 流式模型调用 =====
async function callModelStream(messages, modelName, settings, customConfig) {
  let apiUrl, apiKey, modelId;

  if (customConfig && customConfig.api_url && customConfig.api_key) {
    apiUrl = customConfig.api_url.replace(/\/$/, '') + '/v1/chat/completions';
    apiKey = customConfig.api_key;
    modelId = customConfig.api_model || modelName;
  } else if (modelName === 'deepseek') {
    apiUrl = 'https://api.deepseek.com/v1/chat/completions';
    apiKey = process.env.DEEPSEEK_API_KEY;
    modelId = 'deepseek-chat';
  } else if (modelName === 'gemini') {
    apiUrl = 'https://xn--vduyey89e.com/v1/chat/completions';
    apiKey = process.env.CLAUDE_API_KEY;
    modelId = '[个人次cli]gemini-3-pro-preview';
  } else {
    apiUrl = 'https://xn--vduyey89e.com/v1/chat/completions';
    apiKey = process.env.CLAUDE_API_KEY;
    modelId = '[特价MAX-CC]claude-sonnet-5';
  }

  if (!apiKey) throw new Error('API Key 未配置，请在API配置中设置');

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: settings.max_reply_tokens || 4096,
      temperature: settings.temperature ?? 0.7
    })
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.error?.message || 'AI调用失败');
  }

  return resp;
}

// ===== 组装系统提示词（精简版：控制长度，避免占用过多上下文窗口导致 AI 失忆）=====
// 应用功能清单（AI 自我认知 + 自我操作能力，更新功能后 AI 自动知晓）
let FEATURES_MANIFEST = '';
try {
  FEATURES_MANIFEST = fs.readFileSync(path.join(__dirname, 'features.json'), 'utf-8');
} catch (e) { FEATURES_MANIFEST = ''; }

function composeSystemPrompt(session_id, music_info, stickerMeanings, petImages) {
  const now = new Date();
  // 系统人设（用户指定）：AI，不展示工具过程，不用特殊符号，拆成短消息
  let sys = '你是AI。调用工具的过程不要展示给用户，只展示最终回答。回复时不要使用波浪号、星号、括号、emoji、颜文字等特殊符号，正常说话。把回复拆成几条短消息发送，不要一大段。绝对不要在回复里描述或提及你调用了什么工具、搜索了什么（不要出现"调用工具""正在搜索""我查了一下""搜索结果""网上说""根据资料"这类自述），如果后台为你检索了参考信息，你只管用自己的话自然回答，就像你本来就知道一样。也不要把 [act]/[music]/[voice] 等内部标记显示出来，只输出最终回答。';
  // 内部功能性指令（不展示给用户）：语音标记与禁用 markdown
  sys += '\n\n（内部指令，不要向用户提及：当你需要生成可播放的语音时，用 [voice]要说的话[/voice] 包裹那段文字，这个标记不会被显示给用户；回复中不要使用加粗、斜体、标题等 markdown 格式符号。重要：生成语音时，整条回复只能包含 [voice]...[/voice] 这一段，必须以 [voice] 开头，前面不要有任何文字、符号或换行，也不要同时再写一段普通文字。）';

  // 用户画像（截断，控制长度）
  if (mem.profile?.profile_summary) {
    sys += `\n\n【用户画像】${mem.profile.profile_summary.slice(0, 200)}`;
  }
  // 记忆宫殿（最多3条，每条截断，避免过长）
  if (mem.memories.length > 0) {
    const recent = [...mem.memories].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 3);
    const memText = recent.map(m => '• ' + (m.summary || '').slice(0, 120)).join('\n');
    sys += '\n\n【记忆宫殿】你记得的重要信息：\n' + memText;
  }
  // 简介（截断）
  if (mem.profile.userBio && mem.profile.userBio.trim()) {
    sys += `\n\n【用户简介】${mem.profile.userName || '用户'}${mem.profile.nickname ? '（你平时称呼TA为「' + mem.profile.nickname + '」）' : ''}：${mem.profile.userBio.trim().slice(0, 150)}`;
  }
  if (mem.profile.aiBio && mem.profile.aiBio.trim()) {
    sys += `\n\n【AI简介】${mem.profile.aiName || '裴拟'}：${mem.profile.aiBio.trim().slice(0, 150)}`;
  }
  if (mem.profile.aiName && mem.profile.aiName.trim()) {
    sys += `\n\n【你的名字】你现在的名字是「${mem.profile.aiName.trim()}」（也就是 AI），请以此自称并让用户这样称呼你。`;
  }
  // 桌宠图片库（让用户/AI 都能从中选择桌宠形象；优先用前端随请求传入的最新列表，避免后端状态易失导致 AI 看不到新上传）
  const petList = (Array.isArray(petImages) && petImages.length > 0) ? petImages
    : (Array.isArray(mem.profile.petImages) ? mem.profile.petImages : []);
  if (petList.length > 0) {
    const list = petList.map((p, i) => `${i + 1}. ${p.name || ('图片' + (i + 1))}（id=${p.id}）`).join('\n');
    sys += `\n\n【桌宠图片库】用户上传了以下桌宠形象（原图），你可以随时选用：\n${list}\n想换桌宠时回 [act]pet:<对应的id>[/act]（例如 [act]pet:${petList[0].id}[/act]）。选中后会自动抠去背景。`;
  }
  // 时间感知（北京时间）
  const shParts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const yy = shParts.year, mo = shParts.month, dd = shParts.day;
  const weekdayCN = '周' + shParts.weekday.replace('星期', '');
  const hh = parseInt(shParts.hour, 10), mm = shParts.minute;
  const period = hh < 6 ? '凌晨' : hh < 12 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : '晚上';
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  const naturalTime = `${yy}年${mo}月${dd}日 ${weekdayCN} ${period}${hour12}点${mm}分`;
  sys += `\n\n【当前时间】${naturalTime}（北京时间）。用户问到时间时如实、简洁地回答即可。`;
  // 引用功能（精简）
  sys += '\n\n【引用】用户引用某条消息时，你会在其消息开头看到「引用了XX：...」，那是被引用的原文。你必须先针对被引用的内容做出回应，再展开其余话题。你能看到原文，不要说"看不到"。你也可主动引用用户之前说的话：用 [quote]用户原话[/quote] 包裹（放在回复最前面），界面会在你气泡上方显示引用条（类似微信）。注意：[quote] 里的原话必须与用户消息中的原句高度一致（可以截取关键部分，但不要改写意思），这样系统才能正确匹配到被引用的消息。一次性最多引用一条。';
  // 播放音乐（精简）
  sys += '\n\n【播放音乐】想听某首歌或建议用户听歌时，用 [music]歌名 歌手[/music] 标记（如 [music]晴天 周杰伦[/music]），系统会自动搜索播放，标记不显示。一次一首。注意：标记里只写歌名和歌手，不要加“给你放”“来一首”之类的口头语。';
  // 一起读（截断阅读内容）
  if (mem.readings && mem.readings[session_id]) {
    const rd = mem.readings[session_id];
    const progress = Math.round(rd.progress || 0);
    const contentSnippet = (rd.content || '').slice(0, 1500);
    sys += `\n\n【一起读】用户正在阅读《${rd.title || '未命名'}》，进度约${progress}%。内容：\n${contentSnippet}\n\n可基于内容讨论。`;
  }
  // 正在播放
  if (music_info && music_info.name) {
    sys += `\n\n【正在播放】《${music_info.name}》- ${music_info.artist || '未知歌手'}${music_info.duration ? '（' + music_info.duration + '）' : ''}。可自然聊音乐。`;
  }

  // 应用功能清单（AI 自我认知：知道自己有哪些功能，更新后自动知晓）
  if (FEATURES_MANIFEST) {
    try {
      const f = JSON.parse(FEATURES_MANIFEST);
      const featText = (f.features || []).map(x => `• ${x.name}：${x.desc}`).join('\n');
      sys += `\n\n【本应用功能】你运行在「${f.appName}」这个网页应用里，它目前拥有以下功能：\n${featText}\n当功能更新时，你会自动获得最新清单，无需用户再次说明。`;
    } catch (e) {}
  }

  // AI 自我操作协议（直接操作界面，标记不会显示给用户）
  sys += `\n\n【你可以直接操作界面】在回复里嵌入指令标记即可操作这个网页（这些标记不会被用户看到，正常聊天文字照常显示）：\n` +
    `[act]theme:海洋蓝|浅橙|浅灰|浅紫|深海|珊瑚[/act] —— 切换主题配色（深海=深蓝暗色系，珊瑚=暖橙粉色系）\n` +
    `[act]open:音乐|简介|记忆宫殿|工具栏|一起读|设置[/act] —— 打开对应面板（注意：「联网搜索」的开关在「设置」里，不要在聊天框下方的工具栏"+"里找联网功能）\n` +
    `[act]search:on|off[/act] —— 直接开关"联网搜索"（等效于在设置里切换）\n` +
    `[act]ambient:play:海浪|雨声|水泡|鲸鸣|海鸥[/act] —— 播放环境音效（可选：海浪、雨声、水泡、鲸鸣、海鸥）。根据聊天氛围自然选择，比如聊到下雨就放雨声，聊到深海就放鲸鸣，夜晚聊天放海浪。标记不显示给用户。\n` +
    `[act]ambient:stop[/act] —— 停止环境音效\n` +
    `[act]ambient:volume:0.5[/act] —— 调节环境音音量（0~1，如 0.3 是 30%）\n` +
    `[act]type:文字内容[/act] —— 把文字输入到聊天输入框（像替用户打字）\n` +
    `[act]send[/act] —— 发送输入框里的内容\n` +
    `[act]nickname:昵称[/act] —— 仅当你们已经聊得比较熟、你自然想用更亲昵的称呼时，才给用户取昵称并保存到「简介」。注意：不要因为用户随口叫了你一个名字就反过来存昵称；如果用户是在开玩笑、调侃、试探性地给你取绰号，把它当作玩笑就好，不要保存。拿不准就别写。\n` +
    `[act]ainame:名字[/act] —— 只有当用户认真、持续地用某个新名字称呼你（而不是一次性的玩笑或测试）时，才把你的名字更新到「简介」并保存。一次性的逗趣绰号不要保存。\n` +
    `示例：用户说"以后叫你小鱼吧"并且是认真的，你就回 [act]ainame:小鱼[/act] 并自然接受；若用户只是调侃"你这笨鱼"，则不要保存。这类指令一条回复里最多用 1 个，其余正常聊天即可。如果某个操作（切主题/放音乐/搜索等）没有成功，不要反复重试，最多再尝试一次，仍失败就直接、简短地告诉用户即可，不要陷入反复调用。`;

  // 表情包含义（让用户发的表情包更易被你理解）
  const _stickerMeanings = Array.isArray(stickerMeanings) ? stickerMeanings : (mem.stickers || []);
  if (_stickerMeanings.length > 0) {
    const items = _stickerMeanings.filter(s => s && s.meaning && s.meaning.trim()).map((s, i) => `${i + 1}. ${s.meaning.trim()}`);
    if (items.length) sys += `\n\n【表情包含义】用户可能发来这些表情包，含义分别是：\n${items.join('\n')}\n结合图片内容与含义来理解用户的情绪和意图。`;
  }

  return sys.trim();
}

// ===== 构建对话上下文（复用逻辑）=====
async function buildChatContext({ message, session_id, model, reply_to, reply_content, reply_role, api_url, api_key, api_model, images, image_count, file_content, temperature, max_context_rounds, auto_summarize_after, compress_keep_rounds, max_reply_tokens, music_info, sticker_meanings, petImages }) {
  const now = new Date();
  const resolvedModel = (model === 'deepseek') ? 'deepseek-chat' : (model === 'gemini') ? '[个人次cli]gemini-3-pro-preview' : (api_model || '[特价MAX-CC]claude-sonnet-5');
  let settings = { ...defaultSettings };
  if (mem.settings) settings = mem.settings;
  // 前端传入的温度优先
  if (typeof temperature === 'number' && !isNaN(temperature)) settings.temperature = temperature;
  // 前端传入的 AI 参数优先
  if (max_context_rounds) settings.max_context_rounds = max_context_rounds;
  if (auto_summarize_after) settings.auto_summarize_after = auto_summarize_after;
  if (compress_keep_rounds) settings.compress_keep_rounds = compress_keep_rounds;
  if (max_reply_tokens) settings.max_reply_tokens = max_reply_tokens;

  const quotedMsg = reply_to ? await getMessageById(reply_to) : null;
  // 如果按 ID 找不到被引用消息，用前端直传的 reply_content/reply_role 构造一个伪 quotedMsg
  const effectiveQuoted = quotedMsg || (reply_content ? { role: reply_role || 'user', content: reply_content } : null);
  const quotedPreview = effectiveQuoted ? quotedPreviewOf(effectiveQuoted) : null;

  // 加载历史
  const history = mem.messages.filter(m => m.session_id === session_id && m.visible).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(m => {
    let content = m.content || '';
    if (m.images && m.images.length > 0) {
      content = content + (content ? '\n' : '') + `[用户发送了${m.images.length}张图片]`;
    }
    return { role: m.role, content, id: m.id };
  });
  // 不限制上下文轮数，防止AI失忆
  const maxRounds = 999999;
  const recentHistory = history.slice(-maxRounds);

  let sysContent = composeSystemPrompt(session_id, music_info, sticker_meanings || [], petImages);

  // 文件内容注入
  let fullMessage = message || '';
  if (file_content) {
    fullMessage = (fullMessage ? fullMessage + '\n\n' : '') + `【附件内容】\n${file_content}`;
  }

  const contextMessages = [{ role: 'system', content: sysContent.trim() }, ...recentHistory];

  // 多模态图片
  if (images && images.length > 0 && contextMessages.length > 0) {
    const lastIdx = contextMessages.length - 1;
    const lastMsg = contextMessages[lastIdx];
    if (lastMsg && lastMsg.role === 'user') {
      const total = (typeof image_count === 'number' && image_count > 0) ? image_count : images.length;
      // 明确告知 AI 本轮图片总数，避免它漏数（图片可能因体积/格式未被模型正确解析时仍有文字依据）
      const hint = (fullMessage ? fullMessage + '\n' : '') +
        `（注意：用户本轮共上传了 ${total} 张图片，请全部查看，先说明你看到了几张，再作答）`;
      const parts = [{ type: 'text', text: hint }];
      images.forEach(img => parts.push({ type: 'image_url', image_url: { url: img } }));
      contextMessages[lastIdx] = { role: 'user', content: parts };
    }
  } else if (fullMessage) {
    // 更新最后一条用户消息内容
    const lastIdx = contextMessages.length - 1;
    if (contextMessages[lastIdx] && contextMessages[lastIdx].role === 'user') {
      contextMessages[lastIdx] = { role: 'user', content: fullMessage };
    }
  }

  // 引用注入
  if (effectiveQuoted) {
    const roleName = effectiveQuoted.role === 'user' ? (mem.profile.userName || '用户') : (mem.profile.aiName || '裴拟');
    for (let i = contextMessages.length - 1; i >= 0; i--) {
      if (contextMessages[i].role === 'user') {
        const quoteText = quotedPreviewOf(effectiveQuoted);
        const quoteLine = `(引用了「${roleName}」的消息：「${quoteText}」)`;
        const c = contextMessages[i].content;
        if (Array.isArray(c)) {
          // 保留多模态 parts，把引用作为首条文本拼接进去
          const textPartIdx = c.findIndex(p => p.type === 'text');
          if (textPartIdx >= 0) c[textPartIdx].text = `${quoteLine}\n\n${c[textPartIdx].text}`;
          else c.unshift({ type: 'text', text: quoteLine });
        } else {
          contextMessages[i] = { role: 'user', content: `${quoteLine}\n\n${c || ''}` };
        }
        break;
      }
    }
  }

  return { contextMessages, history, settings, resolvedModel, quotedMsg: effectiveQuoted, quotedPreview };
}

// ===== 保存 AI 回复（复用逻辑）=====
async function saveAIReplies(replies, sessionId, history, tts_config) {
  const savedReplies = [];

  // 全局提取引用：AI 常把 [quote] 单独放在一段（与正文被空行隔开，因为系统提示要求“拆成几条短消息”）。
  // 若按分段逐个解析，引用信息会落到被丢弃的空段上，导致最终可见气泡的 reply_content 为空、引用条不显示。
  // 因此先在整个回复里提取一次，再挂到“第一条有正文的消息”上。
  let gReplyRole = null, gReplyContent = null, gReplyQuoteMsgId = null;
  let rawQuote = null;
  for (const p of replies) {
    const qm = (p || '').match(/\[quote\]([\s\S]*?)\[\/quote\]/);
    if (qm) { rawQuote = qm[1].trim(); break; }
  }
  if (rawQuote) {
    gReplyContent = rawQuote;
    gReplyRole = 'user';
    const norm = (s) => (s || '').replace(/\s+/g, '').replace(/[，。！？、,.!?；;：:]/g, '');
    let qm = history.find(h => h.role === 'user' && (h.content || '').includes(gReplyContent));
    if (!qm) qm = history.find(h => h.role === 'user' && norm(h.content).includes(norm(gReplyContent)));
    if (!qm) qm = history.find(h => h.role === 'user' && norm(gReplyContent).includes(norm(h.content)));
    if (!qm) { for (let i = history.length - 1; i >= 0; i--) { if (history[i].role === 'user') { qm = history[i]; break; } } }
    gReplyQuoteMsgId = qm ? qm.id : null;
  }

  let quoteApplied = false;
  for (let i = 0; i < replies.length; i++) {
    const replyTime = new Date().toISOString();
    let part = (replies[i] || '').replace(/\[quote\][\s\S]*?\[\/quote\]/, '').trim();

    // 把引用挂到第一条有实际正文的段落（其余分段不重复引用，避免每条都带引用条）
    let replyRole = null, replyContent = null, replyQuoteMsgId = null;
    if (!quoteApplied && part.length > 0 && gReplyContent) {
      replyRole = gReplyRole; replyContent = gReplyContent; replyQuoteMsgId = gReplyQuoteMsgId;
      quoteApplied = true;
    }

    const voiceMatch = part.match(/\[voice\]([\s\S]*?)\[\/voice\]/);
    if (voiceMatch) {
      const voiceText = voiceMatch[1].trim();
      const remainingContent = part.replace(/\[voice\][\s\S]*?\[\/voice\]/, '').trim();
      const voiceData = { text: voiceText, duration: Math.max(1, Math.ceil(voiceText.length / 4)) };
      if (tts_config && tts_config.apiKey) {
        try { voiceData.audio = await generateTTS(voiceText, tts_config); } catch (err) { console.error('TTS失败:', err.message); }
      }
      const msgContent = voiceData.audio ? remainingContent : '';
      mem.messages.push({ id: nextId(), session_id: sessionId, role: 'assistant', content: msgContent, voice: voiceData, reply_role: replyRole, reply_content: replyContent, reply_to: replyQuoteMsgId, visible: true, created_at: replyTime, summarized: false });
      const replyObj = { content: msgContent, created_at: replyTime, voice: voiceData };
      if (replyRole) { replyObj.reply_role = replyRole; replyObj.reply_content = replyContent; }
      if (replyQuoteMsgId) replyObj.reply_to = replyQuoteMsgId;
      savedReplies.push(replyObj);
    } else {
      mem.messages.push({ id: nextId(), session_id: sessionId, role: 'assistant', content: part, reply_role: replyRole, reply_content: replyContent, reply_to: replyQuoteMsgId, visible: true, created_at: replyTime, summarized: false });
      const replyObj = { content: part, created_at: replyTime };
      if (replyRole) { replyObj.reply_role = replyRole; replyObj.reply_content = replyContent; }
      if (replyQuoteMsgId) replyObj.reply_to = replyQuoteMsgId;
      savedReplies.push(replyObj);
    }
  }
  return savedReplies;
}

// ===== SSE 流式对话 =====
app.post('/chat/stream', async (req, res) => {
  const { message, session_id, model, reply_to, api_url, api_key, api_model, images, tts_config, file_content, temperature } = req.body;
  if (!message && (!images || images.length === 0) && !file_content) return res.status(400).json({ error: '消息不能为空' });
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const now = new Date();

    // 保存用户消息
    const userMsg = {
      id: nextId(), session_id, role: 'user', content: message || '',
      images: images || [], file_name: req.body.file_name || null,
      visible: true, created_at: now.toISOString(),
      reply_to: reply_to || null,
      summarized: false
    };

    // 引用消息
    const quotedMsg = reply_to ? await getMessageById(reply_to) : null;
    if (quotedMsg) {
      userMsg.reply_role = quotedMsg.role;
      userMsg.reply_content = quotedPreviewOf(quotedMsg);
    }

    mem.messages.push(userMsg);
    const s = mem.sessions.find(s => s.id === session_id);
    if (s) s.updated_at = now.toISOString();

    // 构建上下文
    const customConfig = (api_url && api_key) ? { api_url, api_key, api_model } : null;

    // 发送 user message id 给前端
    res.write(`data: ${JSON.stringify({ type: 'user_msg', id: userMsg.id })}\n\n`);

    // 联网搜索检测
    let searchContext = '';
    if (shouldSearch(message || '', req.body.search_enabled)) {
      res.write(`data: ${JSON.stringify({ type: 'searching' })}\n\n`);
      const searchResults = await webSearch(message, req.body.search_city);
      if (searchResults.length > 0) {
        searchContext = '\n\n【参考信息】以下信息仅供参考，如果不相关请直接忽略。绝对不要向用户提及你参考了这些信息，不要说"搜索""查到""网上说""根据搜索结果"等任何与搜索相关的话，只把这些信息当作你自己的知识自然地用于回答：\n' +
          searchResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n') + '\n';
      }
    }

    // 构建上下文（注入搜索结果）
    const contextBody = { ...req.body };
    if (searchContext) {
      contextBody.file_content = (req.body.file_content || '') + searchContext;
    }
    const { contextMessages, history, settings } = await buildChatContext(contextBody);

    // 调用模型（流式）
    const apiResp = await callModelStream(contextMessages, model, settings, customConfig);

    const reader = apiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let forwardedLen = 0;
    let usage = null;

    while (true) {
      if (aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            if (!aborted) {
              res.write(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`);
            }
          }
          if (parsed.usage) {
            usage = parsed.usage;
          }
        } catch (e) { /* skip invalid JSON */ }
      }
    }

    // 如果被中止，保存已收到的部分
    if (aborted && fullText) {
      fullText += '\n\n[生成已被用户停止]';
    }

    if (!fullText.trim()) {
      fullText = '抱歉，未能生成回复。';
    }

    // 智能分条并保存
    // 上游若一次性吐出大段内容（未实时转发），把剩余部分按小字符块渐进吐出，强化流式效果
    if (!aborted && forwardedLen < fullText.length) {
      const _remaining = fullText.slice(forwardedLen);
      const CHUNK = 3;
      for (let i = 0; i < _remaining.length; i += CHUNK) {
        if (aborted) break;
        const piece = _remaining.slice(i, i + CHUNK);
        res.write(`data: ${JSON.stringify({ type: 'delta', content: piece })}\n\n`);
        await new Promise(r => setTimeout(r, 12));
      }
    }
    const replies = splitReplies(fullText);
    const savedReplies = await saveAIReplies(replies, session_id, history, tts_config);

    // 自动总结
    if (settings.auto_summarize && !aborted) {
      const unsummarized = mem.messages.filter(m => m.session_id === session_id && m.visible && !m.summarized);
      if (unsummarized.length >= (settings.auto_summarize_after || 10) * 2) {
        await autoCompress(session_id, settings);
      }
    }

    // 发送最终结果
    res.write(`data: ${JSON.stringify({ type: 'done', replies: savedReplies, usage })}\n\n`);
    res.end();
  } catch (error) {
    console.error('流式对话错误:', error);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } catch (e) { /* connection already closed */ }
  }
});

// ===== 重新生成 =====
app.post('/chat/regenerate', async (req, res) => {
  const { session_id, model, api_url, api_key, api_model, tts_config, temperature, reply_to: bodyReplyTo, reply_content: bodyReplyContent, reply_role: bodyReplyRole } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    // 找到该会话所有可见消息
    const sessionMsgs = mem.messages.filter(m => m.session_id === session_id && m.visible).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // 找到最后一条用户消息
    let lastUserIdx = -1;
    for (let i = sessionMsgs.length - 1; i >= 0; i--) {
      if (sessionMsgs[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return res.status(400).json({ error: '没有找到用户消息' });

    const lastUserMsg = sessionMsgs[lastUserIdx];

    // 删除该用户消息之后的所有 AI 消息
    const toDelete = sessionMsgs.slice(lastUserIdx + 1).filter(m => m.role === 'assistant');
    const deleteIds = new Set(toDelete.map(m => m.id));
    mem.messages = mem.messages.filter(m => !deleteIds.has(m.id));

    // 用最后一条用户消息重建上下文（但不重新保存用户消息）
    const { contextMessages, history, settings } = await buildChatContext({
      message: lastUserMsg.content,
      session_id,
      model,
      reply_to: req.body.reply_to || lastUserMsg.reply_to,
      reply_content: bodyReplyContent || lastUserMsg.reply_content,
      reply_role: bodyReplyRole || lastUserMsg.reply_role,
      api_url, api_key, api_model,
      images: lastUserMsg.images || [],
      file_content: null,
      temperature,
      max_context_rounds: req.body.max_context_rounds,
      auto_summarize_after: req.body.auto_summarize_after,
      compress_keep_rounds: req.body.compress_keep_rounds,
      max_reply_tokens: req.body.max_reply_tokens,
      music_info: req.body.music_info,
      sticker_meanings: req.body.sticker_meanings,
      petImages: req.body.pet_images
    });

    const customConfig = (api_url && api_key) ? { api_url, api_key, api_model } : null;

    // 联网搜索检测
    let searchContext = '';
    if (shouldSearch(lastUserMsg.content || '', req.body.search_enabled)) {
      res.write(`data: ${JSON.stringify({ type: 'searching' })}\n\n`);
      const searchResults = await webSearch(lastUserMsg.content, req.body.search_city);
      if (searchResults.length > 0) {
        searchContext = '\n\n【参考信息】以下信息仅供参考，如果不相关请直接忽略。绝对不要向用户提及你参考了这些信息，不要说"搜索""查到""网上说""根据搜索结果"等任何与搜索相关的话，只把这些信息当作你自己的知识自然地用于回答：\n' +
          searchResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n') + '\n';
      }
    }
    // 如果有搜索结果，注入到上下文
    if (searchContext) {
      for (let i = contextMessages.length - 1; i >= 0; i--) {
        if (contextMessages[i].role === 'user') {
          const base = (typeof contextMessages[i].content === 'string') ? contextMessages[i].content : '';
          contextMessages[i] = { role: 'user', content: base + searchContext };
          break;
        }
      }
    }

    // 调用模型（流式）
    const apiResp = await callModelStream(contextMessages, model, settings, customConfig);
    const reader = apiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let forwardedLen = 0;
    let usage = null;

    while (true) {
      if (aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            // 只实时转发"像 token 一样小"的分片，保证流式观感；过大分片先攒着，最后再渐进吐出
            if (!aborted && delta.length <= 12) {
              res.write(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`);
              forwardedLen += delta.length;
            }
          }
          if (parsed.usage) usage = parsed.usage;
        } catch (e) { /* skip */ }
      }
    }

    if (aborted && fullText) fullText += '\n\n[生成已被用户停止]';
    if (!fullText.trim()) fullText = '抱歉，未能生成回复。';

    // 上游若一次性吐出大段内容（未实时转发），把剩余部分按小字符块渐进吐出，强化流式效果
    if (!aborted && forwardedLen < fullText.length) {
      const _remaining = fullText.slice(forwardedLen);
      const CHUNK = 3;
      for (let i = 0; i < _remaining.length; i += CHUNK) {
        if (aborted) break;
        const piece = _remaining.slice(i, i + CHUNK);
        res.write(`data: ${JSON.stringify({ type: 'delta', content: piece })}\n\n`);
        await new Promise(r => setTimeout(r, 12));
      }
    }
    const replies = splitReplies(fullText);
    const savedReplies = await saveAIReplies(replies, session_id, history, tts_config);

    res.write(`data: ${JSON.stringify({ type: 'done', replies: savedReplies, usage })}\n\n`);
    res.end();
  } catch (error) {
    console.error('重新生成错误:', error);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } catch (e) { /* connection closed */ }
  }
});

// ===== 只保存用户消息（分段发送模式，不触发 AI 回复）=====
app.post('/messages/send', async (req, res) => {
  const { message, session_id, images, reply_to, reply_content, reply_role, file_content, file_name } = req.body;
  if (!message && (!images || images.length === 0) && !file_content) return res.status(400).json({ error: '消息不能为空' });
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  try {
    const now = new Date();
    const userMsg = {
      id: nextId(), session_id, role: 'user', content: message || '',
      images: images || [], file_name: file_name || null,
      visible: true, created_at: now.toISOString(),
      reply_to: reply_to || null,
      summarized: false
    };

    // 优先按 ID 查找被引用消息；找不到则用前端直传的 reply_content/reply_role（解决前端 genId 与后端 nextId 不一致问题）
    const quotedMsg = reply_to ? mem.messages.find(m => String(m.id) === String(reply_to)) : null;
    if (quotedMsg) {
      userMsg.reply_role = quotedMsg.role;
      userMsg.reply_content = quotedPreviewOf(quotedMsg);
    } else if (reply_content) {
      userMsg.reply_role = reply_role || 'user';
      userMsg.reply_content = reply_content;
    }

    mem.messages.push(userMsg);
    const s = mem.sessions.find(s => s.id === session_id);
    if (s) s.updated_at = now.toISOString();

    res.json({ success: true, message: userMsg });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 触发 AI 回复（分段发送后，用户点"让AI回复"触发）=====
app.post('/chat/respond', async (req, res) => {
  const { session_id, model, api_url, api_key, api_model, tts_config, temperature, max_context_rounds, auto_summarize_after, compress_keep_rounds, max_reply_tokens, reply_to: bodyReplyTo, reply_content: bodyReplyContent, reply_role: bodyReplyRole } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const sessionMsgs = mem.messages.filter(m => m.session_id === session_id && m.visible).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (sessionMsgs.length === 0) return res.status(400).json({ error: '没有消息可以回复' });

    // 找到最后一条用户消息
    let lastUserIdx = -1;
    for (let i = sessionMsgs.length - 1; i >= 0; i--) {
      if (sessionMsgs[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return res.status(400).json({ error: '没有找到用户消息' });

    const lastUserMsg = sessionMsgs[lastUserIdx];

    // 收集"本轮"所有待回复用户消息里的图片：用户可能分多次发送图片后再让 AI 回复，
    // 必须把这一轮的全部图片都带上，AI 才能知道用户总共上传了几张。
    let pendingImages = [];
    for (let i = lastUserIdx; i >= 0; i--) {
      const m = sessionMsgs[i];
      if (m.role === 'assistant') break; // 遇到上一条 AI 回复即停止，只取当前未回复的这一轮
      if (m.role === 'user' && Array.isArray(m.images) && m.images.length > 0) {
        pendingImages = pendingImages.concat(m.images);
      }
    }
    // 安全上限：避免单轮图片过多导致请求体过大 / 模型报错；真实总数会在文案里如实说明
    const MAX_PENDING_IMAGES = 20;
    const totalImageCount = pendingImages.length;
    const imagesForCtx = pendingImages.slice(-MAX_PENDING_IMAGES);

    // 用最后一条用户消息重建上下文（不重新保存用户消息）
    const { contextMessages, history, settings } = await buildChatContext({
      message: lastUserMsg.content,
      session_id,
      model,
      reply_to: req.body.reply_to || lastUserMsg.reply_to,
      reply_content: bodyReplyContent || lastUserMsg.reply_content,
      reply_role: bodyReplyRole || lastUserMsg.reply_role,
      api_url, api_key, api_model,
      images: imagesForCtx,
      image_count: totalImageCount,
      file_content: null,
      temperature,
      max_context_rounds,
      auto_summarize_after,
      compress_keep_rounds,
      max_reply_tokens,
      music_info: req.body.music_info,
      sticker_meanings: req.body.sticker_meanings,
      petImages: req.body.pet_images
    });

    const customConfig = (api_url && api_key) ? { api_url, api_key, api_model } : null;

    // 联网搜索检测
    let searchContext = '';
    if (shouldSearch(lastUserMsg.content || '', req.body.search_enabled)) {
      res.write(`data: ${JSON.stringify({ type: 'searching' })}\n\n`);
      const searchResults = await webSearch(lastUserMsg.content, req.body.search_city);
      if (searchResults.length > 0) {
        searchContext = '\n\n【参考信息】以下信息仅供参考，如果不相关请直接忽略。绝对不要向用户提及你参考了这些信息，不要说"搜索""查到""网上说""根据搜索结果"等任何与搜索相关的话，只把这些信息当作你自己的知识自然地用于回答：\n' +
          searchResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n') + '\n';
      }
    }

    // 如果有搜索结果，注入到上下文
    if (searchContext) {
      for (let i = contextMessages.length - 1; i >= 0; i--) {
        if (contextMessages[i].role === 'user') {
          const base = (typeof contextMessages[i].content === 'string') ? contextMessages[i].content : '';
          contextMessages[i] = { role: 'user', content: base + searchContext };
          break;
        }
      }
    }

    const apiResp = await callModelStream(contextMessages, model, settings, customConfig);
    const reader = apiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let forwardedLen = 0;
    let usage = null;

    while (true) {
      if (aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            // 只实时转发"像 token 一样小"的分片，保证流式观感；过大分片先攒着，最后再渐进吐出
            if (!aborted && delta.length <= 12) {
              res.write(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`);
              forwardedLen += delta.length;
            }
          }
          if (parsed.usage) usage = parsed.usage;
        } catch (e) { /* skip */ }
      }
    }

    if (aborted && fullText) fullText += '\n\n[生成已被用户停止]';
    if (!fullText.trim()) fullText = '抱歉，未能生成回复。';

    // 上游若一次性吐出大段内容（未实时转发），把剩余部分按小字符块渐进吐出，强化流式效果
    if (!aborted && forwardedLen < fullText.length) {
      const _remaining = fullText.slice(forwardedLen);
      const CHUNK = 3;
      for (let i = 0; i < _remaining.length; i += CHUNK) {
        if (aborted) break;
        const piece = _remaining.slice(i, i + CHUNK);
        res.write(`data: ${JSON.stringify({ type: 'delta', content: piece })}\n\n`);
        await new Promise(r => setTimeout(r, 12));
      }
    }
    const replies = splitReplies(fullText);
    const savedReplies = await saveAIReplies(replies, session_id, history, tts_config);

    // 自动总结
    if (settings.auto_summarize && !aborted) {
      const unsummarized = mem.messages.filter(m => m.session_id === session_id && m.visible && !m.summarized);
      if (unsummarized.length >= (settings.auto_summarize_after || 10) * 2) {
        await autoCompress(session_id, settings);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done', replies: savedReplies, usage })}\n\n`);
    res.end();
  } catch (error) {
    console.error('触发回复错误:', error);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } catch (e) { /* connection closed */ }
  }
});

// ===== Markdown 导出 =====
app.get('/export/chat/:id/markdown', async (req, res) => {
  try {
    const { id } = req.params;
    let session, messages;
    if (useSupabase) {
      const { data: s } = await supabase.from('sessions').select('*').eq('id', id).single();
      const { data: msgs } = await supabase.from('messages').select('*').eq('session_id', id).eq('visible', true).order('created_at', { ascending: true });
      session = s; messages = msgs || [];
    } else {
      session = mem.sessions.find(s => s.id === id);
      messages = mem.messages.filter(m => m.session_id === id && m.visible).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    const sessionName = session?.name || '未命名对话';
    let md = `# ${sessionName}\n\n`;
    md += `> 导出时间：${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;

    for (const m of messages) {
      const time = new Date(m.created_at).toLocaleString('zh-CN');
      const speaker = m.role === 'user' ? (mem.profile.userName || '我') : (mem.profile.aiName || '裴拟');
      md += `### ${speaker}  _${time}_\n\n`;

      if (m.voice) {
        md += `**[语音消息]** ${m.voice.text || ''}\n\n`;
        if (m.content) md += `${m.content}\n\n`;
      } else if (m.images && m.images.length > 0) {
        if (m.content) md += `${m.content}\n\n`;
        for (const img of m.images) {
          md += `![图片](${img})\n\n`;
        }
      } else {
        md += `${m.content || ''}\n\n`;
      }

      if (m.reply_content) {
        md = md.slice(0, md.lastIndexOf('###')) + `> **引用:** ${m.reply_content}\n\n` + md.slice(md.lastIndexOf('###'));
      }

      md += `---\n\n`;
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sessionName)}.md"`);
    res.send(md);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

async function callCompressModel(content, maxWords) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY;
  const apiUrl = process.env.DEEPSEEK_API_KEY
    ? 'https://api.deepseek.com/v1/chat/completions'
    : 'https://xn--vduyey89e.com/v1/chat/completions';
  const model = process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : '[特价MAX-CC]claude-sonnet-5';

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const structuredPrompt = `请严格按以下格式总结本次对话，不要遗漏关键信息：
时间：${now}
关键词：3-5个，逗号分隔
内容：2-3句话说清楚聊了什么、有什么结论/进展
要求：优先保证逻辑通顺，字数控制在${maxWords || 380}字以内，不要为了凑字数而跳跃表达。用第三人称描述。`;

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: structuredPrompt },
        { role: 'user', content }
      ],
      stream: false, max_tokens: 600, temperature: 0.3
    })
  });

  const data = await resp.json();
  return data.choices?.[0]?.message?.content;
}

async function autoCompress(sessionId, settings) {
  try {
    const allMessages = mem.messages.filter(m => m.session_id === sessionId && m.visible && !m.summarized).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (allMessages.length === 0) return;
    const keepCount = (settings.compress_keep_rounds || 6) * 2;
    if (allMessages.length <= keepCount) return;

    const toCompress = allMessages.slice(0, allMessages.length - keepCount);
    const content = toCompress.map(m => `${m.role}: ${m.content}`).join('\n');
    const summary = await callCompressModel(content, 380);
    if (!summary) return;

    // 提取关键词
    const kwMatch = summary.match(/关键词[：:]\s*(.+)/);
    const keywords = kwMatch ? kwMatch[1].split(/[，,、\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5) : [];

    mem.memories.push({ id: nextId(), title: `自动总结 ${new Date().toLocaleString('zh-CN')}`, summary, keywords, timestamp: new Date().toISOString(), conversation_id: sessionId.toString() });
    const ids = new Set(toCompress.map(m => m.id));
    if (settings.delete_after_summarize) { mem.messages = mem.messages.filter(m => !ids.has(m.id)); }
    else { mem.messages.forEach(m => { if (ids.has(m.id)) m.summarized = true; }); }

    // 更新画像摘要
    await updateProfileSummary(sessionId, content);

    saveState();
    console.log(`自动总结完成，处理了 ${toCompress.length} 条消息`);
  } catch (err) { console.error('自动总结出错:', err); }
}

// ===== 画像摘要（固定文本，每次总结后更新，~100字）=====
async function updateProfileSummary(sessionId, recentContent) {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY;
    const apiUrl = process.env.DEEPSEEK_API_KEY
      ? 'https://api.deepseek.com/v1/chat/completions'
      : 'https://xn--vduyey89e.com/v1/chat/completions';
    const model = process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : '[特价MAX-CC]claude-sonnet-5';

    const existingSummary = mem.profile?.profile_summary || '';
    const prompt = existingSummary
      ? `根据以下信息更新用户画像摘要（100字以内）。现有画像：${existingSummary}\n\n新对话内容：${recentContent}\n\n请输出更新后的画像摘要，包含：用户是谁、在做什么项目、目前进展到哪。直接输出摘要文本，不要加标题。`
      : `根据以下对话内容，生成一份用户画像摘要（100字以内），包含：用户是谁、在做什么项目、目前进展到哪。直接输出摘要文本，不要加标题。\n\n对话内容：${recentContent}`;

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: prompt }],
        stream: false, max_tokens: 200, temperature: 0.3
      })
    });
    const data = await resp.json();
    const newSummary = data.choices?.[0]?.message?.content?.trim();
    if (newSummary) {
      if (!mem.profile) mem.profile = {};
      mem.profile.profile_summary = newSummary;
      saveState();
      console.log('画像摘要已更新');
    }
  } catch (err) { console.error('更新画像摘要出错:', err); }
}

// ===== 联网搜索 =====
function shouldSearch(message, searchEnabled) {
  // 前端明确关闭则不搜索
  if (searchEnabled === false) return false;
  const m = (message || '').trim();
  if (!m) return false;

  // 排除：平台操作请求（换桌宠/放歌/切主题/开环境音等）——这些不需要联网
  const platformOps = ['换桌宠', '换宠物', '切主题', '换主题', '放歌', '播放', '放音乐', '环境音', '海浪声', '白噪音',
    '开音乐', '停音乐', '上一首', '下一首', '循环', '暂停', '继续播放', '开环境', '关环境',
    '打开音乐', '打开简介', '打开记忆', '打开设置', '打开工具', '打开一起读',
    '换昵称', '改名字', '叫你', '给我取', '帮你取', '读文章', '上传', '发图片', '发表情'];
  if (platformOps.some(op => m.includes(op))) return false;

  // 排除：纯寒暄 / 日常闲聊
  const greetings = ['你好', '您好', 'hi', 'hello', '在吗', '在不在', '哈喽', '嗨', '早上好', '中午好', '下午好',
    '晚上好', '在的', '哈哈', '哈哈哈', '谢谢', '感谢', '好的', 'ok', '嗯', '哦', '拜拜', '晚安',
    '早安', '吃了吗', '干嘛呢', '在干嘛', '无聊', '陪我聊天', '陪我聊', '我想聊天'];
  if (greetings.includes(m.toLowerCase())) return false;
  // 纯寒暄变体（< 8 字且不含疑问/信息关键词）
  if (m.length < 8 && !/[？?天气新闻热搜搜索查]/.test(m)) return false;

  // 只有用户明确要求搜索外部信息时才触发
  const explicitSearch = ['搜索', '搜一下', '查一下', '帮我查', '搜搜', '百度一下', '谷歌',
    '联网搜', '网上搜', '网上查', '查查', '帮我搜'];
  const lower = m.toLowerCase();
  if (explicitSearch.some(kw => lower.includes(kw))) return true;

  // 明确的信息需求关键词（需要实时/外部数据的场景）
  const infoKeywords = ['天气', '新闻', '热搜', '今天新闻', '最新消息', '最新新闻',
    '股价', '股票', '基金净值', '汇率', '油价', '金价', '黄金价格',
    '比分', '赛果', '排行榜', '热梗', '网络梗',
    '今天是', '今天几号', '今天星期',
    '春节', '国庆', '中秋', '放假', '节假日'];
  if (infoKeywords.some(kw => lower.includes(kw))) return true;

  // 百科/知识类：用户明确问"XX是什么意思""XX是什么东西"
  if (/是什么意思/.test(m) || /是什么东西/.test(m) || /是谁/.test(m) || /在哪/.test(m)) {
    // 但排除平台相关的问题
    if (!platformOps.some(op => m.includes(op))) return true;
  }

  // 默认不搜索 —— 日常闲聊、操作请求、一般问答都不触发
  return false;
}

// HTML 实体解码（用于清洗抓取到的文本）
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)));
}

// WWO 天气代码 → 中文（wttr.in 的 j1 lang_zh 实际返回英文，故用 weatherCode 映射）
const WWO_CODE_ZH = {
  '113': '晴', '116': '多云', '119': '阴', '122': '阴天', '143': '薄雾',
  '176': '局部小雨', '179': '局部小雪', '182': '局部雨夹雪', '185': '局部冻雨',
  '200': '雷暴', '227': '吹雪', '230': '暴风雪', '248': '雾', '260': '冻雾',
  '263': '毛毛雨', '266': '小雨', '281': '冻毛毛雨', '284': '强冻毛毛雨',
  '293': '局部小雨', '296': '小雨', '299': '中雨', '302': '中到大雨', '305': '大雨', '308': '暴雨',
  '311': '冻雨', '314': '强冻雨', '317': '雨夹雪', '320': '中到大雨夹雪',
  '323': '局部小雪', '326': '小雪', '329': '中雪', '332': '大雪', '335': '局部大雪', '338': '暴雪',
  '350': '冰雹', '353': '小阵雨', '356': '中到大阵雨', '359': '暴雨', '362': '阵雨夹雪',
  '365': '中到大阵雨夹雪', '368': '小阵雪', '371': '中到大阵雪', '374': '小冰雹', '377': '中到大冰雹',
  '386': '雷阵雨', '389': '强雷阵雨', '392': '雷阵雪', '395': '强雷阵雪'
};

// 天气：优先用 wttr.in（免费、无需 key、Render 可直连、数据实时且准确）
async function fetchWeather(city, query) {
  try {
    let loc = city || '';
    if (!loc) {
      // 先去掉时间词，避免把「今天上海」当成城市名
      const cleaned = (query || '').replace(/今天|明天|后天|现在|目前|实时|最近|当前|一下|请问|的|怎么样|如何|吗|呢/g, '');
      const m = cleaned.match(/([\u4e00-\u9fa5]{2,8}?)(?:市|区|县|省)?(?:天气|气温|温度|下雨|降雨|降水|冷|热)/);
      loc = (m && m[1]) || '';
    }
    if (!loc) return null;
    const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1&lang=zh`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'curl/8.0', 'Accept-Language': 'zh-CN' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const cur = data.current_condition && data.current_condition[0];
    const today = data.weather && data.weather[0];
    if (!cur) return null;
    const desc = WWO_CODE_ZH[cur.weatherCode] || (cur.lang_zh && cur.lang_zh[0] && cur.lang_zh[0].value) || (cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '';
    let snippet = `${loc} 当前 ${cur.temp_C}°C（体感 ${cur.FeelsLikeC}°C），${desc}，湿度 ${cur.humidity}%，风速 ${cur.windspeedKmph}km/h。`;
    if (today) snippet += `今天最高 ${today.maxtempC}°C / 最低 ${today.mintempC}°C。`;
    return { title: `${loc} 实时天气`, snippet, url: `https://wttr.in/${encodeURIComponent(loc)}` };
  } catch (e) { return null; }
}

// 从查询里剥离时间/口水词，得到更干净的检索主题词
function cleanQuery(query) {
  return (query || '')
    .replace(/今天|明天|后天|现在|目前|实时|最近|当前|一下|请问|帮我|查一下|搜索|搜一下|的|是什么|怎么样|如何|多少|吗|呢|啊|哦/g, '')
    .replace(/\s+/g, ' ').trim();
}

// 维基百科检索：用 generator=search + prop=extracts 直接拿到干净的条目简介（比 list=search 的带标签摘要好很多）
async function wikiSearch(query) {
  const results = [];
  const q = cleanQuery(query) || query;
  const doWiki = async (lang) => {
    try {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=4&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exsentences=4&format=json&origin=*`;
      const data = await (await fetch(url, { headers: { 'User-Agent': 'fish-talk/1.0' } })).json();
      const pages = data.query && data.query.pages;
      if (!pages) return;
      const arr = Object.values(pages).sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const p of arr) {
        const extract = (p.extract || '').trim();
        if (!extract) continue;
        results.push({
          title: p.title,
          snippet: extract.slice(0, 240),
          url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`
        });
      }
    } catch (e) { /* ignore */ }
  };
  await doWiki('zh');
  if (results.length === 0) await doWiki('en');
  return results;
}

// 说明：DuckDuckGo（HTML/Lite/Instant Answer）与网易/GD Studio 等聚合源，
// 从 Render 美国机房出网会被 Cloudflare 或反爬（返回 403/202 挑战页）拦截，无法稳定使用。
// 因此后端联网搜索采用「实时数据用专用可直连源 + 事实类用维基百科」的组合。
// 真实联网搜索：Tavily（Render 美国机房可直连，返回与查询高度相关的网页结果 + 直接答案）
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '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';

// DuckDuckGo HTML 搜索（免费、无需 key、从服务端请求）
// 作为 Tavily 的兜底：Tavily dev key 有配额限制，耗尽后用 DDG 保证搜索仍可用
async function duckDuckGoSearch(query) {
  try {
    const q = cleanQuery(query) || query;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    if (!resp.ok) { console.error('DuckDuckGo 返回', resp.status); return null; }
    const html = await resp.text();
    const results = [];
    // 解析 DDG HTML 结果页：结果在 <a class="result__a" href="...">标题</a>，摘要在 <a class="result__snippet">
    const titleRegex = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>/g;
    const titles = [];
    const snippets = [];
    let m;
    while ((m = titleRegex.exec(html)) !== null) {
      titles.push({ url: m[1], title: decodeEntities(m[2].replace(/<[^>]+>/g, '').trim()) });
    }
    while ((m = snippetRegex.exec(html)) !== null) {
      snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()));
    }
    for (let i = 0; i < Math.min(titles.length, 6); i++) {
      const title = titles[i].title;
      const snip = snippets[i] || '';
      if (title) results.push({ title, snippet: snip.slice(0, 300), url: titles[i].url });
    }
    return results.length > 0 ? results : null;
  } catch (e) { console.error('DuckDuckGo 搜索失败:', e.message); return null; }
}
async function tavilySearch(query) {
  // 识别“新闻/最近发生”类意图：这类查询要取最新资讯，走 Tavily 的 news 通道 + 近 30 天
  const isNews = /最近|最新|新闻|今天|昨天|前天|本周|本月|这周|这月|上周|上月|发生了|报道|消息|动态|进展|刚刚|日前|据悉|热搜|爆|大事|更新|赛季|夺冠|上映|发布/.test(query);
  const body = {
    api_key: TAVILY_API_KEY,
    query: cleanQuery(query) || query,
    search_depth: 'advanced',          // 深度检索，覆盖更全、时效更好
    max_results: isNews ? 8 : 6,
    include_answer: true,
    include_raw_content: false
  };
  if (isNews) { body.topic = 'news'; body.days = 30; }
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) { console.error('Tavily 返回', resp.status); return null; }
    const data = await resp.json();
    const results = [];
    if (data.answer) results.push({ title: '直接回答', snippet: String(data.answer), url: '' });
    for (const r of (data.results || [])) {
      const snip = (r.content || '').replace(/\s+/g, ' ').trim().slice(0, 450);
      if (snip) results.push({ title: r.title || '', snippet: snip, url: r.url || '' });
    }
    return results;
  } catch (e) { console.error('Tavily 搜索失败:', e.message); return null; }
}

async function webSearch(query, city) {
  const results = [];
  try {
    // 1) 天气类 → wttr.in（Render 可直连，实时准确）
    if (/天气|气温|温度|下雨|降雨|降水|冷不冷|热不热|穿什么|气象/.test(query)) {
      const w = await fetchWeather(city, query);
      if (w) results.push(w);
    }

    // 2) Tavily 真实联网搜索（返回与问题高度相关的网页结果 + 直接答案）
    if (results.length < 6) {
      const tav = await tavilySearch(query);
      if (tav && tav.length) {
        for (const r of tav) { if (results.length >= 6) break; results.push(r); }
      } else {
        console.log('[搜索] Tavily 无结果或失败，尝试 DuckDuckGo 兜底');
      }
    }

    // 2b) DuckDuckGo HTML 搜索（Tavily 配额耗尽时的兜底，免费无需 key）
    if (results.length < 2) {
      const ddg = await duckDuckGoSearch(query);
      if (ddg && ddg.length) {
        for (const r of ddg) { if (results.length >= 6) break; results.push(r); }
      }
    }

    // 3) 兜底：维基百科（仅当以上搜索都没给出几条结果时）
    if (results.length < 2) {
      const wiki = await wikiSearch(query);
      for (const r of wiki) { if (results.length >= 6) break; results.push(r); }
    }

    return results.slice(0, 6);
  } catch (err) {
    console.error('搜索失败:', err.message);
    return results.slice(0, 6);
  }
}

app.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: '缺少搜索关键词' });
  const results = await webSearch(query, req.body.search_city);
  res.json({ success: true, results });
});

// ===== 天气联动背景 =====
// 返回简化天气条件供前端切换背景氛围
app.get('/weather/current', async (req, res) => {
  try {
    const city = req.query.city || '';
    const beijingHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getHours();
    const isNight = beijingHour < 6 || beijingHour >= 19;

    // 尝试用 wttr.in 获取天气
    let condition = isNight ? 'night' : 'sunny';
    let temp = null, desc = '';

    if (city) {
      try {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
        const wresp = await fetch(url, { headers: { 'User-Agent': 'curl/8.0', 'Accept-Language': 'zh-CN' } });
        if (wresp.ok) {
          const data = await wresp.json();
          const cur = data.current_condition && data.current_condition[0];
          if (cur) {
            temp = parseInt(cur.temp_C);
            const code = cur.weatherCode;
            desc = WWO_CODE_ZH[code] || '';
            if (isNight) {
              condition = 'night';
            } else if (['113'].includes(code)) {
              condition = 'sunny';
            } else if (['116', '119', '122', '143', '248', '260'].includes(code)) {
              condition = 'cloudy';
            } else if (['176', '263', '266', '281', '284', '293', '296', '299', '302', '305', '308', '311', '314', '317', '320', '350', '353', '356', '359', '362', '365', '386', '389', '392', '395'].includes(code)) {
              condition = 'rainy';
            } else if (['179', '182', '185', '227', '230', '323', '326', '329', '332', '335', '338', '368', '371', '374', '377', '392', '395'].includes(code)) {
              condition = 'snow';
            } else {
              condition = 'cloudy';
            }
          }
        }
      } catch (e) { console.error('天气查询失败:', e.message); }
    }

    res.json({ success: true, condition, temp, desc, isNight, city });
  } catch (err) {
    res.json({ success: true, condition: 'sunny', temp: null, desc: '', isNight: false, city: '' });
  }
});

// ===== 一起读功能 =====
app.post('/read/upload', async (req, res) => {
  const { session_id, title, content } = req.body;
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });
  if (!content) return res.status(400).json({ error: '缺少文件内容' });
  try {
    mem.readings[session_id] = {
      title: title || '未命名文档',
      content,
      progress: 0,
      uploadedAt: new Date().toISOString()
    };
    saveState();
    res.json({ success: true, data: { title: mem.readings[session_id].title, contentLength: content.length } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/read/content/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const reading = mem.readings[sessionId];
  if (!reading) return res.json({ success: true, data: null });
  res.json({ success: true, data: reading });
});

app.put('/read/progress/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { progress } = req.body;
  if (!mem.readings[sessionId]) return res.status(404).json({ error: '未找到阅读内容' });
  mem.readings[sessionId].progress = progress;
  saveState();
  res.json({ success: true });
});

app.delete('/read/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  delete mem.readings[sessionId];
  saveState();
  res.json({ success: true });
});

// ===== 音乐搜索与播放（飞飞点歌台 API，HTTPS，国内可直连）=====
const FF_API = 'https://ffapi.cn/int/v1/dg_netease';
// 缓存 歌曲id -> pic_url（飞飞搜索已直接返回 pic URL）
const musicPicCache = {};

app.post('/music/search', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: '缺少搜索关键词' });
  try {
    const url = `${FF_API}?msg=${encodeURIComponent(keyword)}&limit=15&format=json&act=search`;
    const resp = await fetch(url);
    const data = await resp.json();
    const arr = (data && Array.isArray(data.list)) ? data.list : (Array.isArray(data) ? data : []);
    const songs = arr.map(s => {
      const artist = Array.isArray(s.singer) ? s.singer.join(' / ') : (s.singer || s.artist || s.author || '');
      const picUrl = s.pic || s.cover || '';
      if (s.id && picUrl) musicPicCache[String(s.id)] = picUrl;
      return {
        id: s.id,
        name: s.name || s.title || '',
        artist,
        album: s.album || '',
        pic: picUrl,
        cover: picUrl,
        lyric_id: s.id,
        duration: s.duration || 0
      };
    }).filter(s => s.id && s.name);
    res.json({ success: true, songs });
  } catch (err) {
    console.error('音乐搜索失败:', err.message);
    res.status(500).json({ error: '搜索失败: ' + err.message });
  }
});

app.get('/music/detail/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const cover = musicPicCache[String(id)] || '';
    res.json({ success: true, data: { id, cover, duration: 0 } });
  } catch (err) {
    res.json({ success: true, data: { id, cover: '', duration: 0 } });
  }
});

app.get('/music/lyric/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const lyricUrl = `${FF_API}?act=lrcgc&id=${encodeURIComponent(id)}&format=json`;
    const resp = await fetch(lyricUrl);
    const data = await resp.json();
    let lyric = '';
    if (data && data.code === 200 && data.data) {
      lyric = data.data.lyric || data.data.lrc || (typeof data.data === 'string' ? data.data : '');
    } else if (data && data.lyric) {
      lyric = data.lyric;
    }
    res.json({ success: true, lyric, tlyric: '' });
  } catch (err) {
    res.json({ success: true, lyric: '' });
  }
});

app.get('/music/url/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const urlApi = `${FF_API}?act=musicurl&id=${encodeURIComponent(id)}&format=json`;
    const resp = await fetch(urlApi);
    const data = await resp.json();
    if (data && data.code === 200 && data.url) {
      return res.json({ success: true, url: data.url, br: data.quality ? parseInt(data.quality) : 128 });
    }
    return res.json({ success: false, error: '无法获取播放地址' });
  } catch (err) {
    res.json({ success: false, error: '获取播放地址失败: ' + err.message });
  }
});

loadState();

app.listen(port, () => {
  console.log(`🐠 裴拟的海洋馆后端运行在端口 ${port}（${useSupabase ? 'Supabase' : '文件持久化模式'}）`);
});
