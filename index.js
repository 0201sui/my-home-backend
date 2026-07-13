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
  profile: { userBio: '', aiBio: '', userName: '我', aiName: '鱼说' },
  _id: 1
};
function nextId() { return String(mem._id++); }

const defaultSettings = {
  system_prompt: '你是「鱼说」，一个温暖、有爱的AI伙伴。你住在一片虚拟的海洋里，陪伴用户聊天、思考和生活。请用温柔但自然的语气回复，像一个真正的朋友。',
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
  res.json({ status: 'ok', message: '鱼说后端正常运行', storage: useSupabase ? 'supabase' : 'memory' });
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
  const { message, session_id, model, reply_to, stickers, api_url, api_key, api_model } = req.body;
  if (!message) return res.status(400).json({ error: '消息不能为空' });
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  try {
    const now = new Date().toISOString();
    let settings = { ...defaultSettings };
    if (mem.settings) settings = mem.settings;

    // 保存用户消息
    const userMsg = { id: nextId(), session_id, role: 'user', content: message, visible: true, created_at: now, reply_to: reply_to || null, summarized: false };
    mem.messages.push(userMsg);
    const s = mem.sessions.find(s => s.id === session_id);
    if (s) s.updated_at = now;

    // 加载记忆
    let memoryContext = '';
    if (mem.memories.length > 0) {
      const recent = [...mem.memories].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5);
      memoryContext = '\n\n【记忆宫殿摘要】\n' + recent.map(m => m.summary).join('\n') + '\n';
    }

    // 加载历史
    const history = mem.messages.filter(m => m.session_id === session_id && m.visible).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(m => ({ role: m.role, content: m.content }));
    const maxRounds = settings.max_context_rounds * 2;
    const recentHistory = history.slice(-maxRounds);

    // 时间感知 + 简介
    const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    let sysContent = settings.system_prompt || '';
    sysContent += `\n\n【当前时间】${timeStr}（北京时间）`;
    sysContent += `\n\n【用户简介】${mem.profile.userName}：${mem.profile.userBio || '暂无'}`;
    sysContent += `\n【你的简介】${mem.profile.aiName}：${mem.profile.aiBio || '暂无'}`;
    sysContent += memoryContext;

    const contextMessages = [{ role: 'system', content: sysContent.trim() }, ...recentHistory];

    // 调用模型
    const customConfig = (api_url && api_key) ? { api_url, api_key, api_model } : null;
    const aiResponse = await callModel(contextMessages, model, settings, customConfig);

    // 保存 AI 回复
    mem.messages.push({ id: nextId(), session_id, role: 'assistant', content: aiResponse, visible: true, created_at: new Date().toISOString(), summarized: false });

    // 自动总结
    if (settings.auto_summarize) {
      const unsummarized = mem.messages.filter(m => m.session_id === session_id && m.visible && !m.summarized);
      if (unsummarized.length >= (settings.auto_summarize_after || 10) * 2) {
        await autoCompress(session_id, settings);
      }
    }

    res.json({ reply: aiResponse });
  } catch (error) {
    console.error('对话错误:', error);
    res.status(500).json({ error: error.message });
  }
});

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
  console.log(`🐟 鱼说后端运行在端口 ${port}（${useSupabase ? 'Supabase' : '内存模式'}）`);
});
