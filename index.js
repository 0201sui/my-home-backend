require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ===== 存储层：有 Supabase 就用，没有就用内存 =====
const useSupabase = !!process.env.SUPABASE_URL;
let supabase = null;
if (useSupabase) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// 内存存储（Supabase 不可用时用）
const mem = {
  sessions: [],
  messages: [],
  memories: [],
  settings: null,
  _id: 1
};
function nextId() { return String(mem._id++); }

// ===== 健康检查 =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '后端服务正常运行！', storage: useSupabase ? 'supabase' : 'memory' });
});

// ===== 会话管理 =====

// 获取所有会话
app.get('/sessions', async (req, res) => {
  try {
    if (useSupabase) {
      const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
      if (error) throw error;
      res.json({ sessions: data });
    } else {
      const sessions = [...mem.sessions].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      res.json({ sessions });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建新会话
app.post('/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    const now = new Date().toISOString();
    if (useSupabase) {
      const { data, error } = await supabase
        .from('sessions').insert({ name: name || '新对话', created_at: now, updated_at: now })
        .select().single();
      if (error) throw error;
      res.json({ session: data });
    } else {
      const session = { id: nextId(), name: name || '新对话', created_at: now, updated_at: now };
      mem.sessions.push(session);
      res.json({ session });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重命名会话
app.put('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (useSupabase) {
      const { data, error } = await supabase
        .from('sessions').update({ name, updated_at: new Date().toISOString() }).eq('id', id).select().single();
      if (error) throw error;
      res.json({ session: data });
    } else {
      const s = mem.sessions.find(s => s.id === id);
      if (s) { s.name = name; s.updated_at = new Date().toISOString(); }
      res.json({ session: s });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除会话（同时删除消息）
app.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (useSupabase) {
      await supabase.from('messages').delete().eq('session_id', id);
      const { error } = await supabase.from('sessions').delete().eq('id', id);
      if (error) throw error;
    } else {
      mem.sessions = mem.sessions.filter(s => s.id !== id);
      mem.messages = mem.messages.filter(m => m.session_id !== id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 消息管理 =====

// 获取某个会话的消息
app.get('/sessions/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    if (useSupabase) {
      const { data, error } = await supabase
        .from('messages').select('*').eq('session_id', id).eq('visible', true).order('created_at', { ascending: true });
      if (error) throw error;
      res.json({ messages: data });
    } else {
      const messages = mem.messages
        .filter(m => m.session_id === id && m.visible)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      res.json({ messages });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 设置管理 =====

const defaultSettings = {
  system_prompt: '你是一个温暖、有爱的AI伙伴。',
  temperature: 0.7,
  max_context_rounds: 20,
  compress_threshold: 4000,
  compress_keep_rounds: 6,
  max_reply_tokens: 1024
};

// 获取设置
app.get('/settings', async (req, res) => {
  try {
    if (useSupabase) {
      const { data, error } = await supabase.from('settings').select('*').limit(1).single();
      if (error && error.code === 'PGRST116') {
        res.json({ settings: defaultSettings });
        return;
      }
      if (error) throw error;
      res.json({ settings: data });
    } else {
      res.json({ settings: mem.settings || defaultSettings });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新设置
app.put('/settings', async (req, res) => {
  try {
    const updates = req.body;
    updates.updated_at = new Date().toISOString();
    if (useSupabase) {
      const { data: existing } = await supabase.from('settings').select('id').limit(1).single();
      if (existing) {
        const { data, error } = await supabase.from('settings').update(updates).eq('id', existing.id).select().single();
        if (error) throw error;
        res.json({ settings: data });
      } else {
        const { data, error } = await supabase.from('settings').insert(updates).select().single();
        if (error) throw error;
        res.json({ settings: data });
      }
    } else {
      mem.settings = { ...mem.settings, ...updates };
      res.json({ settings: mem.settings });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 核心对话接口 =====
app.post('/chat', async (req, res) => {
  const { message, session_id, model } = req.body;

  if (!message) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  if (!session_id) {
    return res.status(400).json({ error: '缺少 session_id' });
  }

  try {
    const now = new Date().toISOString();

    // 1. 保存用户消息
    if (useSupabase) {
      await supabase.from('messages').insert({ session_id, role: 'user', content: message, visible: true, created_at: now });
      await supabase.from('sessions').update({ updated_at: now }).eq('id', session_id);
    } else {
      mem.messages.push({ id: nextId(), session_id, role: 'user', content: message, visible: true, created_at: now });
    }

    // 2. 获取设置
    let settings = { ...defaultSettings };
    if (useSupabase) {
      const { data: settingsData } = await supabase.from('settings').select('*').limit(1).single();
      if (settingsData) settings = settingsData;
    } else {
      if (mem.settings) settings = mem.settings;
    }

    // 3. 加载记忆摘要
    let memoryContext = '';
    if (useSupabase) {
      const { data: memories } = await supabase.from('memories').select('summary').order('timestamp', { ascending: false }).limit(5);
      if (memories && memories.length > 0) {
        memoryContext = '以下是之前对话的记忆摘要：\n' + memories.map(m => m.summary).join('\n') + '\n\n';
      }
    } else {
      if (mem.memories.length > 0) {
        const recent = [...mem.memories].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5);
        memoryContext = '以下是之前对话的记忆摘要：\n' + recent.map(m => m.summary).join('\n') + '\n\n';
      }
    }

    // 4. 加载历史消息
    let history = [];
    if (useSupabase) {
      const { data } = await supabase.from('messages').select('role, content').eq('session_id', session_id).eq('visible', true).order('created_at', { ascending: true });
      history = data || [];
    } else {
      history = mem.messages
        .filter(m => m.session_id === session_id && m.visible)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(m => ({ role: m.role, content: m.content }));
    }

    const maxRounds = settings.max_context_rounds * 2;
    const recentHistory = history.slice(-maxRounds);

    // 5. 组装上下文
    const systemContent = (settings.system_prompt || '') + '\n\n' + memoryContext;
    const contextMessages = [
      { role: 'system', content: systemContent.trim() },
      ...recentHistory
    ];

    // 6. 调用 AI 模型
    const aiResponse = await callModel(contextMessages, model, settings);

    // 7. 保存 AI 回复
    if (useSupabase) {
      await supabase.from('messages').insert({ session_id, role: 'assistant', content: aiResponse, visible: true, created_at: new Date().toISOString() });
    } else {
      mem.messages.push({ id: nextId(), session_id, role: 'assistant', content: aiResponse, visible: true, created_at: new Date().toISOString() });
    }

    // 8. 检查是否需要记忆压缩
    await checkAndCompress(session_id, settings);

    // 9. 返回回复
    res.json({ reply: aiResponse });

  } catch (error) {
    console.error('对话错误:', error);
    res.status(500).json({ error: '服务器内部错误: ' + error.message });
  }
});

// ===== 调用 AI 模型 =====
async function callModel(messages, modelName, settings) {
  let apiUrl, apiKey, modelId;

  if (modelName === 'deepseek') {
    apiUrl = 'https://api.deepseek.com/v1/chat/completions';
    apiKey = process.env.DEEPSEEK_API_KEY;
    modelId = 'deepseek-chat';
  } else {
    // 默认使用 Claude（通过中转站）
    apiUrl = 'https://xn--vduyey89e.com/v1/chat/completions';
    apiKey = process.env.CLAUDE_API_KEY;
    modelId = '[特价MAX-CC]claude-sonnet-5';
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelId,
      messages: messages,
      stream: false,
      max_tokens: settings.max_reply_tokens || 1024,
      temperature: settings.temperature || 0.7
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('模型API错误:', data);
    throw new Error(data.error?.message || 'AI 调用失败');
  }

  return data.choices?.[0]?.message?.content || '无回复';
}

// ===== 记忆压缩 =====
async function checkAndCompress(sessionId, settings) {
  try {
    let allMessages = [];
    if (useSupabase) {
      const { data } = await supabase.from('messages').select('id, role, content, created_at').eq('session_id', sessionId).eq('visible', true).order('created_at', { ascending: true });
      allMessages = data || [];
    } else {
      allMessages = mem.messages
        .filter(m => m.session_id === sessionId && m.visible)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    if (!allMessages || allMessages.length === 0) return;

    const totalChars = allMessages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 2);

    if (estimatedTokens < (settings.compress_threshold || 4000)) return;

    console.log(`Token 估算: ${estimatedTokens}，超过阈值 ${settings.compress_threshold}，开始压缩...`);

    const keepCount = (settings.compress_keep_rounds || 6) * 2;
    if (allMessages.length <= keepCount) return;

    const toCompress = allMessages.slice(0, allMessages.length - keepCount);
    const compressContent = toCompress.map(m => `${m.role}: ${m.content}`).join('\n');

    const summaryMessages = [
      { role: 'system', content: '你是一个记忆压缩助手。请将以下对话内容压缩成一段简短的摘要，保留关键信息、情感和重要细节。用第三人称描述。控制在200字以内。' },
      { role: 'user', content: compressContent }
    ];

    // 记忆压缩优先用 DeepSeek，没有就退回 Claude
    const compressApiKey = process.env.DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY;
    const compressApiUrl = process.env.DEEPSEEK_API_KEY
      ? 'https://api.deepseek.com/v1/chat/completions'
      : 'https://xn--vduyey89e.com/v1/chat/completions';
    const compressModel = process.env.DEEPSEEK_API_KEY
      ? 'deepseek-chat'
      : '[特价MAX-CC]claude-sonnet-5';

    const compressResponse = await fetch(compressApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${compressApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: compressModel,
        messages: summaryMessages,
        stream: false,
        max_tokens: 300,
        temperature: 0.3
      })
    });

    const compressData = await compressResponse.json();
    const summary = compressData.choices?.[0]?.message?.content;

    if (!summary) {
      console.error('压缩失败，跳过');
      return;
    }

    // 保存摘要
    if (useSupabase) {
      await supabase.from('memories').insert({ summary, timestamp: new Date().toISOString(), conversation_id: sessionId.toString() });
      const idsToHide = toCompress.map(m => m.id);
      await supabase.from('messages').update({ visible: false }).in('id', idsToHide);
    } else {
      mem.memories.push({ id: nextId(), summary, timestamp: new Date().toISOString(), conversation_id: sessionId.toString() });
      const idsToHide = new Set(toCompress.map(m => m.id));
      mem.messages.forEach(m => { if (idsToHide.has(m.id)) m.visible = false; });
    }

    console.log(`压缩完成！隐藏了 ${toCompress.length} 条消息，生成摘要。`);

  } catch (err) {
    console.error('压缩过程出错:', err);
  }
}

// ===== 启动服务 =====
app.listen(port, () => {
  console.log(`Bunny's Home 后端运行在端口 ${port}（存储: ${useSupabase ? 'Supabase' : '内存模式'}）`);
});
