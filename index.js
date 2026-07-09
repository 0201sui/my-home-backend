require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== 健康检查 =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '后端服务正常运行！' });
});

// ===== 会话管理 =====

// 获取所有会话
app.get('/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ sessions: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建新会话
app.post('/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    const { data, error } = await supabase
      .from('sessions')
      .insert({ name: name || '新对话', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    res.json({ session: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重命名会话
app.put('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const { data, error } = await supabase
      .from('sessions')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    res.json({ session: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除会话（同时删除消息）
app.delete('/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await supabase.from('messages').delete().eq('session_id', id);
    const { error } = await supabase.from('sessions').delete().eq('id', id);
    if (error) throw error;
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
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', id)
      .eq('visible', true)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ messages: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 设置管理 =====

// 获取设置
app.get('/settings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .limit(1)
      .single();
    if (error && error.code === 'PGRST116') {
      // 没有设置记录，返回默认值
      res.json({ settings: {
        system_prompt: '你是一个温暖、有爱的AI伙伴。',
        temperature: 0.7,
        max_context_rounds: 20,
        compress_threshold: 4000,
        compress_keep_rounds: 6,
        max_reply_tokens: 1024
      }});
      return;
    }
    if (error) throw error;
    res.json({ settings: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新设置
app.put('/settings', async (req, res) => {
  try {
    const updates = req.body;
    updates.updated_at = new Date().toISOString();

    // 先查是否有记录
    const { data: existing } = await supabase.from('settings').select('id').limit(1).single();

    if (existing) {
      const { data, error } = await supabase
        .from('settings')
        .update(updates)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      res.json({ settings: data });
    } else {
      const { data, error } = await supabase
        .from('settings')
        .insert(updates)
        .select()
        .single();
      if (error) throw error;
      res.json({ settings: data });
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
    // 1. 保存用户消息到数据库
    await supabase.from('messages').insert({
      session_id,
      role: 'user',
      content: message,
      visible: true,
      created_at: new Date().toISOString()
    });

    // 2. 更新会话时间
    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    // 3. 获取设置
    let settings = {
      system_prompt: '你是一个温暖、有爱的AI伙伴。',
      temperature: 0.7,
      max_context_rounds: 20,
      compress_threshold: 4000,
      compress_keep_rounds: 6,
      max_reply_tokens: 1024
    };
    const { data: settingsData } = await supabase.from('settings').select('*').limit(1).single();
    if (settingsData) settings = settingsData;

    // 4. 加载记忆摘要
    let memoryContext = '';
    const { data: memories } = await supabase
      .from('memories')
      .select('summary')
      .order('timestamp', { ascending: false })
      .limit(5);
    if (memories && memories.length > 0) {
      memoryContext = '以下是之前对话的记忆摘要：\n' + memories.map(m => m.summary).join('\n') + '\n\n';
    }

    // 5. 加载当前会话历史消息
    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', session_id)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    // 只保留最近 N 轮
    const maxRounds = settings.max_context_rounds * 2;
    const recentHistory = history ? history.slice(-maxRounds) : [];

    // 6. 组装上下文
    const systemContent = (settings.system_prompt || '') + '\n\n' + memoryContext;
    const contextMessages = [
      { role: 'system', content: systemContent.trim() },
      ...recentHistory
    ];

    // 7. 调用 AI 模型
    const aiResponse = await callModel(contextMessages, model, settings);

    // 8. 保存 AI 回复到数据库
    await supabase.from('messages').insert({
      session_id,
      role: 'assistant',
      content: aiResponse,
      visible: true,
      created_at: new Date().toISOString()
    });

    // 9. 检查是否需要记忆压缩
    await checkAndCompress(session_id, settings);

    // 10. 返回回复
    res.json({ reply: aiResponse });

  } catch (error) {
    console.error('对话错误:', error);
    res.status(500).json({ error: '服务器内部错误: ' + error.message });
  }
});

// ===== 调用 AI 模型 =====
async function callModel(messages, modelName, settings) {
  // 根据模型名称选择 API
  let apiUrl, apiKey, modelId;

  if (modelName === 'deepseek') {
    apiUrl = 'https://api.deepseek.com/v1/chat/completions';
    apiKey = process.env.DEEPSEEK_API_KEY;
    modelId = 'deepseek-chat';
  } else {
    // 默认使用 Claude（通过中转站）
    apiUrl = 'https://xn--vduyey89e.com/v1/chat/completions';
    apiKey = process.env.CLAUDE_API_KEY;
    modelId = '[特特价次kiro]claude-opus-4-6';
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
    // 获取当前会话所有可见消息
    const { data: allMessages } = await supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    if (!allMessages) return;

    // 估算 token 数（简单按字符数 / 2 估算中文）
    const totalChars = allMessages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 2);

    // 如果没超过阈值，不压缩
    if (estimatedTokens < (settings.compress_threshold || 4000)) return;

    console.log(`Token 估算: ${estimatedTokens}，超过阈值 ${settings.compress_threshold}，开始压缩...`);

    // 保留最近几轮，压缩更早的
    const keepCount = (settings.compress_keep_rounds || 6) * 2;
    if (allMessages.length <= keepCount) return;

    const toCompress = allMessages.slice(0, allMessages.length - keepCount);

    // 组装要压缩的内容
    const compressContent = toCompress.map(m => `${m.role}: ${m.content}`).join('\n');

    // 调用 DeepSeek 做压缩摘要（便宜）
    const summaryMessages = [
      { role: 'system', content: '你是一个记忆压缩助手。请将以下对话内容压缩成一段简短的摘要，保留关键信息、情感和重要细节。用第三人称描述。控制在200字以内。' },
      { role: 'user', content: compressContent }
    ];

    let summary;
    const compressApiKey = process.env.DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY;
    const compressApiUrl = process.env.DEEPSEEK_API_KEY
      ? 'https://api.deepseek.com/v1/chat/completions'
      : 'https://xn--vduyey89e.com/v1/chat/completions';
    const compressModel = process.env.DEEPSEEK_API_KEY
      ? 'deepseek-chat'
      : '[特特价次kiro]claude-opus-4-6';

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
    summary = compressData.choices?.[0]?.message?.content;

    if (!summary) {
      console.error('压缩失败，跳过');
      return;
    }

    // 保存摘要到 memories 表
    await supabase.from('memories').insert({
      summary: summary,
      timestamp: new Date().toISOString(),
      conversation_id: sessionId.toString()
    });

    // 把被压缩的消息标记为不可见
    const idsToHide = toCompress.map(m => m.id);
    await supabase
      .from('messages')
      .update({ visible: false })
      .in('id', idsToHide);

    console.log(`压缩完成！隐藏了 ${idsToHide.length} 条消息，生成摘要。`);

  } catch (err) {
    console.error('压缩过程出错:', err);
    // 压缩失败不影响正常对话
  }
}

// ===== 启动服务 =====
app.listen(port, () => {
  console.log(`Bunny's Home 后端运行在端口 ${port}`);
});
