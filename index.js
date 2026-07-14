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
  profile: { userBio: '', aiBio: '', userName: '我', aiName: '裴拟' },
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
  // 3) 没有换行但很长：按句号/问号/感叹号切成多段（避免一整坨；含语音/引用标记则不切，防止打断标记）
  if (!t.includes('\n') && t.length >= 120 && !t.includes('[voice]') && !t.includes('[quote]')) {
    const sentences = t.split(/(?<=[。！？!?])/).map(p => p.trim()).filter(Boolean);
    if (sentences.length > 1) {
      parts = [];
      let buf = '';
      for (const s of sentences) {
        if (buf && (buf.length + s.length) > 80) { parts.push(buf); buf = ''; }
        buf += s;
      }
      if (buf) parts.push(buf);
      if (parts.length > 1) return parts;
    }
  }
  return [t];
}

const defaultSettings = {
  system_prompt: '',
  temperature: 0.7,
  max_context_rounds: 250,
  compress_threshold: 4000,
  compress_keep_rounds: 15,
  max_reply_tokens: 1024,
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
    if (useSupabase) { await supabase.from('messages').delete().eq('id', id); }
    else { mem.messages = mem.messages.filter(m => m.id !== id); }
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
  const { urls } = req.body;
  if (!Array.isArray(urls)) return res.status(400).json({ success: false, error: 'urls 必须是数组' });
  const newStickers = urls.map(url => ({ id: nextId(), url, createdAt: new Date().toISOString() }));
  mem.stickers.push(...newStickers);
  res.json({ success: true, data: newStickers });
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
    const resolvedModel = (model === 'deepseek') ? 'deepseek-chat' : (api_model || '[特价MAX-CC]claude-sonnet-5');
    let settings = { ...defaultSettings };
    if (mem.settings) settings = mem.settings;

    // 引用消息查找（让 AI 真正"看到"被引用的内容）
    const quotedMsg = reply_to ? mem.messages.find(m => String(m.id) === String(reply_to)) : null;
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
    let sysContent = composeSystemPrompt(session_id, req.body.music_info);

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
      max_tokens: settings.max_reply_tokens || 1024,
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
      max_tokens: settings.max_reply_tokens || 1024,
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
function composeSystemPrompt(session_id, music_info) {
  const now = new Date();
  // 像朋友一样自然对话，不使用括号/引号/星号等符号，也不使用 markdown 格式符号
  let sys = '你是AI助手，由Claude提供支持。像朋友一样自然地聊天，不要使用括号（）、引号""、方括号[]或星号*来表达动作或旁白，也不要用加粗/斜体/标题等格式符号，直接说就行。需要生成语音时用[voice]文字[/voice]包裹。';

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
    sys += `\n\n【用户简介】${mem.profile.userName || '用户'}：${mem.profile.userBio.trim().slice(0, 150)}`;
  }
  if (mem.profile.aiBio && mem.profile.aiBio.trim()) {
    sys += `\n\n【AI简介】${mem.profile.aiName || '裴拟'}：${mem.profile.aiBio.trim().slice(0, 150)}`;
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
  sys += '\n\n【引用】用户引用某条消息时，你会在其消息开头看到「引用了XX：...」，请据此回应。你也可主动引用用户之前的话：用 [quote]原话[/quote] 包裹，会显示在你气泡上方（像微信）。';
  // 播放音乐（精简）
  sys += '\n\n【播放音乐】想听某首歌或建议用户听歌时，用 [music]歌名 歌手[/music] 标记（如 [music]晴天 周杰伦[/music]），系统会自动搜索播放，标记不显示。一次一首。';
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
  return sys.trim();
}

// ===== 构建对话上下文（复用逻辑）=====
function buildChatContext({ message, session_id, model, reply_to, api_url, api_key, api_model, images, file_content, temperature, max_context_rounds, auto_summarize_after, compress_keep_rounds, max_reply_tokens, music_info }) {
  const now = new Date();
  const resolvedModel = (model === 'deepseek') ? 'deepseek-chat' : (api_model || '[特价MAX-CC]claude-sonnet-5');
  let settings = { ...defaultSettings };
  if (mem.settings) settings = mem.settings;
  // 前端传入的温度优先
  if (typeof temperature === 'number' && !isNaN(temperature)) settings.temperature = temperature;
  // 前端传入的 AI 参数优先
  if (max_context_rounds) settings.max_context_rounds = max_context_rounds;
  if (auto_summarize_after) settings.auto_summarize_after = auto_summarize_after;
  if (compress_keep_rounds) settings.compress_keep_rounds = compress_keep_rounds;
  if (max_reply_tokens) settings.max_reply_tokens = max_reply_tokens;

  const quotedMsg = reply_to ? mem.messages.find(m => String(m.id) === String(reply_to)) : null;
  const quotedPreview = quotedMsg ? quotedPreviewOf(quotedMsg) : null;

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

  let sysContent = composeSystemPrompt(session_id, music_info);

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
      const parts = [];
      if (fullMessage) parts.push({ type: 'text', text: fullMessage });
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
  if (quotedMsg) {
    const roleName = quotedMsg.role === 'user' ? (mem.profile.userName || '用户') : (mem.profile.aiName || '裴拟');
    for (let i = contextMessages.length - 1; i >= 0; i--) {
      if (contextMessages[i].role === 'user') {
        const quoteText = quotedPreviewOf(quotedMsg);
        const base = (typeof contextMessages[i].content === 'string') ? contextMessages[i].content : (fullMessage || '');
        contextMessages[i] = { role: 'user', content: `(引用了「${roleName}」的消息：「${quoteText}」)\n\n${base}` };
        break;
      }
    }
  }

  return { contextMessages, history, settings, resolvedModel, quotedMsg, quotedPreview };
}

// ===== 保存 AI 回复（复用逻辑）=====
async function saveAIReplies(replies, sessionId, history, tts_config) {
  const savedReplies = [];
  for (let i = 0; i < replies.length; i++) {
    const replyTime = new Date().toISOString();
    let part = replies[i];

    let replyRole = null, replyContent = null, replyQuoteMsgId = null;
    const quoteMatch = part.match(/\[quote\]([\s\S]*?)\[\/quote\]/);
    if (quoteMatch) {
      replyContent = quoteMatch[1].trim();
      replyRole = 'user';
      const qm = history.find(h => h.role === 'user' && (h.content || '').includes(replyContent));
      replyQuoteMsgId = qm ? qm.id : null;
      part = part.replace(/\[quote\][\s\S]*?\[\/quote\]/, '').trim();
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
    const quotedMsg = reply_to ? mem.messages.find(m => String(m.id) === String(reply_to)) : null;
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
        searchContext = '\n\n【联网搜索结果】以下是相关搜索结果，请参考这些信息回答用户问题：\n' +
          searchResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n') + '\n';
      }
    }

    // 构建上下文（注入搜索结果）
    const contextBody = { ...req.body };
    if (searchContext) {
      contextBody.file_content = (req.body.file_content || '') + searchContext;
    }
    const { contextMessages, history, settings } = buildChatContext(contextBody);

    // 调用模型（流式）
    const apiResp = await callModelStream(contextMessages, model, settings, customConfig);

    const reader = apiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
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
  const { session_id, model, api_url, api_key, api_model, tts_config, temperature } = req.body;
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
    const { contextMessages, history, settings } = buildChatContext({
      message: lastUserMsg.content,
      session_id,
      model,
      reply_to: lastUserMsg.reply_to,
      api_url, api_key, api_model,
      images: lastUserMsg.images || [],
      file_content: null,
      temperature,
      max_context_rounds: req.body.max_context_rounds,
      auto_summarize_after: req.body.auto_summarize_after,
      compress_keep_rounds: req.body.compress_keep_rounds,
      max_reply_tokens: req.body.max_reply_tokens,
      music_info: req.body.music_info
    });

    const customConfig = (api_url && api_key) ? { api_url, api_key, api_model } : null;

    // 联网搜索检测
    let searchContext = '';
    if (shouldSearch(lastUserMsg.content || '', req.body.search_enabled)) {
      res.write(`data: ${JSON.stringify({ type: 'searching' })}\n\n`);
      const searchResults = await webSearch(lastUserMsg.content, req.body.search_city);
      if (searchResults.length > 0) {
        searchContext = '\n\n【联网搜索结果】以下是相关搜索结果，请参考这些信息回答用户问题：\n' +
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
            if (!aborted) res.write(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`);
          }
          if (parsed.usage) usage = parsed.usage;
        } catch (e) { /* skip */ }
      }
    }

    if (aborted && fullText) fullText += '\n\n[生成已被用户停止]';
    if (!fullText.trim()) fullText = '抱歉，未能生成回复。';

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
  const { message, session_id, images, reply_to, file_content, file_name } = req.body;
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

    const quotedMsg = reply_to ? mem.messages.find(m => String(m.id) === String(reply_to)) : null;
    if (quotedMsg) {
      userMsg.reply_role = quotedMsg.role;
      userMsg.reply_content = quotedPreviewOf(quotedMsg);
    }

    mem.messages.push(userMsg);
    const s = mem.sessions.find(s => s.id === session_id);
    if (s) s.updated_at = now.toISOString();

    res.json({ success: true, message: userMsg });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 触发 AI 回复（分段发送后，用户点"让AI回复"触发）=====
app.post('/chat/respond', async (req, res) => {
  const { session_id, model, api_url, api_key, api_model, tts_config, temperature, max_context_rounds, auto_summarize_after, compress_keep_rounds, max_reply_tokens } = req.body;
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

    // 用最后一条用户消息重建上下文（不重新保存用户消息）
    const { contextMessages, history, settings } = buildChatContext({
      message: lastUserMsg.content,
      session_id,
      model,
      reply_to: lastUserMsg.reply_to,
      api_url, api_key, api_model,
      images: lastUserMsg.images || [],
      file_content: null,
      temperature,
      max_context_rounds,
      auto_summarize_after,
      compress_keep_rounds,
      max_reply_tokens,
      music_info: req.body.music_info
    });

    const customConfig = (api_url && api_key) ? { api_url, api_key, api_model } : null;

    // 联网搜索检测
    let searchContext = '';
    if (shouldSearch(lastUserMsg.content || '', req.body.search_enabled)) {
      res.write(`data: ${JSON.stringify({ type: 'searching' })}\n\n`);
      const searchResults = await webSearch(lastUserMsg.content, req.body.search_city);
      if (searchResults.length > 0) {
        searchContext = '\n\n【联网搜索结果】以下是相关搜索结果，请参考这些信息回答用户问题：\n' +
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
            if (!aborted) res.write(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`);
          }
          if (parsed.usage) usage = parsed.usage;
        } catch (e) { /* skip */ }
      }
    }

    if (aborted && fullText) fullText += '\n\n[生成已被用户停止]';
    if (!fullText.trim()) fullText = '抱歉，未能生成回复。';

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
  // 如果前端明确关闭了搜索，则不搜索
  if (searchEnabled === false) return false;
  const keywords = ['天气', '新闻', '今天', '最新', '现在', '目前', '最近', '当前', '实时', '比分', '股价', '汇率', '油价', '热搜', '发生了什么', '什么时候', '多少钱', '价格', '排名', '排行榜'];
  const lower = message.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

async function webSearch(query, city) {
  try {
    // 如果是天气相关查询且有城市，在查询中加入城市名
    let searchQuery = query;
    if (city && (query.includes('天气') || query.includes('气温') || query.includes('温度'))) {
      searchQuery = `${city} ${query}`;
    }
    // 使用 DuckDuckGo Instant Answer API
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(searchQuery)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
    const ddgResp = await fetch(ddgUrl);
    const ddgData = await ddgResp.json();

    let results = [];

    // 优先用 AbstractText
    if (ddgData.AbstractText) {
      results.push({ title: ddgData.Heading || query, snippet: ddgData.AbstractText, url: ddgData.AbstractURL || '' });
    }

    // RelatedTopics
    if (ddgData.RelatedTopics && ddgData.RelatedTopics.length > 0) {
      for (const t of ddgData.RelatedTopics.slice(0, 5)) {
        if (t.Text) {
          results.push({ title: t.Text.slice(0, 60), snippet: t.Text, url: t.FirstURL || '' });
        }
        if (t.Topics && t.Topics.length > 0) {
          for (const sub of t.Topics.slice(0, 2)) {
            if (sub.Text) results.push({ title: sub.Text.slice(0, 60), snippet: sub.Text, url: sub.FirstURL || '' });
          }
        }
      }
    }

    // Answer
    if (ddgData.Answer) {
      results.unshift({ title: '直接回答', snippet: ddgData.Answer, url: '' });
    }

    // 如果 DuckDuckGo 没结果，尝试 Wikipedia API
    if (results.length === 0) {
      const wikiUrl = `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`;
      const wikiResp = await fetch(wikiUrl);
      const wikiData = await wikiResp.json();
      if (wikiData.query?.search) {
        for (const item of wikiData.query.search) {
          const snippet = item.snippet?.replace(/<[^>]+>/g, '') || '';
          results.push({ title: item.title, snippet, url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(item.title)}` });
        }
      }
    }

    return results.slice(0, 6);
  } catch (err) {
    console.error('搜索失败:', err.message);
    return [];
  }
}

app.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: '缺少搜索关键词' });
  const results = await webSearch(query);
  res.json({ success: true, results });
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

// ===== 音乐搜索与播放 =====
app.post('/music/search', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: '缺少搜索关键词' });
  try {
    // 使用网易云搜索API (POST with form data)
    const params = new URLSearchParams({
      s: keyword,
      type: '1',
      offset: '0',
      total: 'true',
      limit: '15'
    });
    const resp = await fetch('https://music.163.com/api/search/get', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://music.163.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: params.toString()
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    let songs = (data.result?.songs || []).map(s => ({
      id: s.id,
      name: s.name,
      artist: (s.artists || []).map(a => a.name).join(' / '),
      album: s.album?.name || '',
      duration: s.duration || 0
    }));
    // 如果没结果，尝试备用搜索
    if (songs.length === 0) {
      const altResp = await fetch(`https://music.163.com/api/search/pc?s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=15`, {
        method: 'GET',
        headers: {
          'Referer': 'https://music.163.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const altData = await altResp.json();
      songs = (altData.result?.songs || []).map(s => ({
        id: s.id,
        name: s.name,
        artist: (s.artists || []).map(a => a.name).join(' / '),
        album: s.album?.name || '',
        duration: s.duration || 0
      }));
    }
    res.json({ success: true, songs });
  } catch (err) {
    console.error('音乐搜索失败:', err.message);
    res.status(500).json({ error: '搜索失败: ' + err.message });
  }
});

app.get('/music/detail/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const detailUrl = `https://music.163.com/api/song/detail/?ids=[${id}]`;
    const resp = await fetch(detailUrl, {
      headers: { 'Referer': 'https://music.163.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = await resp.json();
    const song = data.songs?.[0];
    if (!song) return res.json({ success: false, error: '未找到歌曲' });
    res.json({
      success: true,
      data: {
        id: song.id,
        name: song.name,
        artist: (song.artists || []).map(a => a.name).join(' / '),
        album: song.album?.name || '',
        cover: song.album?.picUrl || '',
        duration: song.duration || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: '获取详情失败: ' + err.message });
  }
});

app.get('/music/lyric/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const lyricUrl = `https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`;
    const resp = await fetch(lyricUrl, {
      headers: { 'Referer': 'https://music.163.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = await resp.json();
    res.json({ success: true, lyric: data.lrc?.lyric || '', tlyric: data.tlyric?.lyric || '' });
  } catch (err) {
    res.json({ success: true, lyric: '' });
  }
});

app.get('/music/url/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const urlApi = `https://music.163.com/api/song/enhance/player/url/v1?ids=[${id}]&level=standard&encodeType=mp3`;
    const resp = await fetch(urlApi, {
      headers: { 'Referer': 'https://music.163.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = await resp.json();
    const songData = data.data?.[0];
    if (songData && songData.url) {
      res.json({ success: true, url: songData.url });
    } else {
      // Fallback: try outer URL
      res.json({ success: true, url: `https://music.163.com/song/media/outer/url?id=${id}.mp3` });
    }
  } catch (err) {
    res.json({ success: true, url: `https://music.163.com/song/media/outer/url?id=${id}.mp3` });
  }
});

loadState();

app.listen(port, () => {
  console.log(`🐠 裴拟的海洋馆后端运行在端口 ${port}（${useSupabase ? 'Supabase' : '文件持久化模式'}）`);
});
