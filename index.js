require('dotenv').config();
const express = require('express');
const cors = require('cors');

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
  settings: null,
  stickers: [],
  profile: { userBio: '', aiBio: '', userName: '我', aiName: '裴拟' },
  _id: 1
};
function nextId() { return String(mem._id++); }

// 生成被引用消息的可读预览（用于引用条显示）
function quotedPreviewOf(m) {
  if (!m) return '';
  if (m.voice) return '[语音消息]';
  if (m.images && m.images.length > 0) return `[图片×${m.images.length}]`;
  if (m.content && m.content.includes('[贴纸]')) return '[贴纸]';
  return (m.content || '').trim();
}

const defaultSettings = {
  system_prompt: '你可以把回复分成多条消息发送（用空行分隔每条，简单回复保持一条即可）。当你想用语音回复时，用 [voice]文字内容[/voice] 标记。',
  temperature: 0.7,
  max_context_rounds: 20,
  compress_threshold: 4000,
  compress_keep_rounds: 6,
  max_reply_tokens: 1024,
  auto_summarize: true,
  auto_summarize_after: 10,
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
      res.json({ message: msg });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (useSupabase) { await supabase.from('messages').delete().eq('id', id); }
    else { mem.messages = mem.messages.filter(m => m.id !== id); }
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
      res.json({ success: true, data: m });
    }
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (useSupabase) { await supabase.from('memories').delete().eq('id', id); }
    else { mem.memories = mem.memories.filter(m => m.id !== id); }
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
    const summary = await callCompressModel(content, max_words || 200);
    if (!summary) return res.json({ success: false, error: '总结失败' });

    const memory = {
      title: `对话总结 ${new Date().toLocaleString('zh-CN')}`,
      summary,
      keywords: [],
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

    // 加载记忆
    let memoryContext = '';
    if (mem.memories.length > 0) {
      const recent = [...mem.memories].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5);
      memoryContext = '\n\n【记忆宫殿摘要】以下是你记得的重要信息：\n' + recent.map(m => '• ' + (m.summary || '')).join('\n') + '\n';
    }

    // 加载历史（文本 + 图片标记）
    const history = mem.messages.filter(m => m.session_id === session_id && m.visible).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(m => {
      let content = m.content || '';
      if (m.images && m.images.length > 0) {
        content = content + (content ? '\n' : '') + `[用户发送了${m.images.length}张图片]`;
      }
      return { role: m.role, content };
    });
    const maxRounds = settings.max_context_rounds * 2;
    const recentHistory = history.slice(-maxRounds);

    // 极简提示词 — 保留模型原生特性，只加功能指令
    let sysContent = settings.system_prompt || '你可以把回复分成多条消息发送（用空行分隔每条，简单回复保持一条即可）。当你想用语音回复时，用 [voice]文字内容[/voice] 标记。';
    if (memoryContext) sysContent += memoryContext;

    // 条件注入简介：只有填写了才给 AI 读
    if (mem.profile.userBio && mem.profile.userBio.trim()) {
      sysContent += `\n\n【用户简介】${mem.profile.userName || '用户'}：${mem.profile.userBio.trim()}`;
    }
    if (mem.profile.aiBio && mem.profile.aiBio.trim()) {
      sysContent += `\n\n【AI简介】${mem.profile.aiName || '裴拟'}：${mem.profile.aiBio.trim()}`;
    }

    // 时间感知（北京时间 + 周几）
    const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    sysContent += `\n\n【当前时间】现在是 ${timeStr}（北京时间，${weekday}）`;

    // 引用功能说明（让 AI 知道可以引用 + 会被告知用户引用了什么）
    sysContent += '\n\n【引用功能】当用户引用了某条消息，你会在用户消息开头看到「引用了XX的消息：...」。你也可以引用用户之前说的话来回应，写法是用 [quote]你要引用的内容[/quote] 包裹，被引用的内容会显示在你消息气泡的上方。';

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
    const aiResponse = await callModel(contextMessages, model, settings, customConfig);

    // 智能分条：AI 用空行分隔；过短则不强制分条，过短片段合并到上一条
    let replies;
    if (aiResponse.length < 100) {
      replies = [aiResponse];
    } else {
      const parts = aiResponse.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
      replies = [];
      for (const part of parts) {
        if (replies.length > 0 && part.length < 25) {
          replies[replies.length - 1] += '\n\n' + part;
        } else {
          replies.push(part);
        }
      }
      if (replies.length === 0) replies = [aiResponse];
    }

    // 保存每条 AI 回复（检测 [voice] 语音标记 与 [quote] 引用标记）
    const savedReplies = [];
    for (let i = 0; i < replies.length; i++) {
      const replyTime = new Date().toISOString();
      let part = replies[i];

      // 解析 AI 的引用标记
      let replyRole = null, replyContent = null;
      const quoteMatch = part.match(/\[quote\]([\s\S]*?)\[\/quote\]/);
      if (quoteMatch) {
        replyContent = quoteMatch[1].trim();
        replyRole = 'user';
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
        mem.messages.push({ id: nextId(), session_id, role: 'assistant', content: msgContent, voice: voiceData, reply_role: replyRole, reply_content: replyContent, visible: true, created_at: replyTime, summarized: false });
        const replyObj = { content: msgContent, created_at: replyTime, voice: voiceData };
        if (replyRole) { replyObj.reply_role = replyRole; replyObj.reply_content = replyContent; }
        savedReplies.push(replyObj);
      } else {
        mem.messages.push({ id: nextId(), session_id, role: 'assistant', content: part, reply_role: replyRole, reply_content: replyContent, visible: true, created_at: replyTime, summarized: false });
        const replyObj = { content: part, created_at: replyTime };
        if (replyRole) { replyObj.reply_role = replyRole; replyObj.reply_content = replyContent; }
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

    res.json({ replies: savedReplies });
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
  return data.choices?.[0]?.message?.content || '无回复';
}

async function callCompressModel(content, maxWords) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY;
  const apiUrl = process.env.DEEPSEEK_API_KEY
    ? 'https://api.deepseek.com/v1/chat/completions'
    : 'https://xn--vduyey89e.com/v1/chat/completions';
  const model = process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : '[特价MAX-CC]claude-sonnet-5';

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `你是一个记忆压缩助手。请将以下对话内容压缩成一段简短的摘要，保留关键信息、情感和重要细节。用第三人称描述。控制在${maxWords || 200}字以内。` },
        { role: 'user', content }
      ],
      stream: false, max_tokens: 500, temperature: 0.3
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
    const summary = await callCompressModel(content, 200);
    if (!summary) return;

    mem.memories.push({ id: nextId(), title: `自动总结 ${new Date().toLocaleString('zh-CN')}`, summary, keywords: [], timestamp: new Date().toISOString(), conversation_id: sessionId.toString() });
    const ids = new Set(toCompress.map(m => m.id));
    if (settings.delete_after_summarize) { mem.messages = mem.messages.filter(m => !ids.has(m.id)); }
    else { mem.messages.forEach(m => { if (ids.has(m.id)) m.summarized = true; }); }
    console.log(`自动总结完成，处理了 ${toCompress.length} 条消息`);
  } catch (err) { console.error('自动总结出错:', err); }
}

app.listen(port, () => {
  console.log(`🐠 裴拟的海洋馆后端运行在端口 ${port}（${useSupabase ? 'Supabase' : '内存模式'}）`);
});
