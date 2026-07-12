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
  let apiUrl, apiKey, modelId;

  if (modelName === 'deepseek') {
    apiUrl = 'https://api.deepseek.com/v1/chat/completions';
    apiKey = process.env.DEEPSEEK_API_KEY;
    modelId = 'deepseek-chat';
  } else {
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

// ===== 记忆压缩（自动触发，带关键词提取） =====
async function checkAndCompress(sessionId, settings) {
  try {
    const { data: allMessages } = await supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    if (!allMessages) return;

    const totalChars = allMessages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 2);

    if (estimatedTokens < (settings.compress_threshold || 4000)) return;

    console.log(`Token 估算: ${estimatedTokens}，超过阈值 ${settings.compress_threshold}，开始压缩...`);

    const keepCount = (settings.compress_keep_rounds || 6) * 2;
    if (allMessages.length <= keepCount) return;

    const toCompress = allMessages.slice(0, allMessages.length - keepCount);
    const compressContent = toCompress.map(m => `${m.role}: ${m.content}`).join('\n');

    // 改进的压缩提示词：同时提取关键词
    const summaryMessages = [
      {
        role: 'system',
        content: '你是一个记忆压缩助手。请将以下对话内容压缩，并提取关键词。请严格按JSON格式回复：{"title":"简短标题10字以内","summary":"压缩摘要200字以内，保留关键信息和情感","keywords":["关键词1","关键词2","关键词3"]}'
      },
      { role: 'user', content: compressContent }
    ];

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
        max_tokens: 400,
        temperature: 0.3
      })
    });

    const compressData = await compressResponse.json();
    const replyContent = compressData.choices?.[0]?.message?.content;

    if (!replyContent) {
      console.error('压缩失败，跳过');
      return;
    }

    // 尝试解析 JSON 格式的回复
    let title = '对话记忆';
    let summary = replyContent;
    let keywords = [];

    try {
      const jsonMatch = replyContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        title = parsed.title || '对话记忆';
        summary = parsed.summary || replyContent;
        keywords = parsed.keywords || [];
      }
    } catch (e) {
      // JSON解析失败，用原文作为摘要
      console.log('压缩结果非JSON格式，使用原文作为摘要');
    }

    // 保存摘要到 memories 表（包含关键词）
    await supabase.from('memories').insert({
      session_id: 'global',
      title: title,
      summary: summary,
      keywords: keywords,
      timestamp: new Date().toISOString(),
      conversation_id: sessionId.toString()
    });

    // 把被压缩的消息标记为不可见
    const idsToHide = toCompress.map(m => m.id);
    await supabase
      .from('messages')
      .update({ visible: false })
      .in('id', idsToHide);

    console.log(`压缩完成！隐藏了 ${idsToHide.length} 条消息，生成摘要: ${title}`);

  } catch (err) {
    console.error('压缩过程出错:', err);
  }
}

// ===== 记忆宫殿接口 =====

// 获取所有记忆（支持按关键词筛选）
app.get('/memories', async (req, res) => {
  try {
    const { keyword } = req.query;
    let query = supabase
      .from('memories')
      .select('*')
      .order('timestamp', { ascending: false });

    if (keyword) {
      query = query.contains('keywords', [keyword]);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 搜索记忆（关键词 + 内容模糊匹配）
app.get('/memories/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ success: true, data: [] });

    // 按关键词精确匹配
    const { data: keywordMatches, error: err1 } = await supabase
      .from('memories')
      .select('*')
      .contains('keywords', [q])
      .order('timestamp', { ascending: false });

    if (err1) throw err1;

    // 按摘要内容模糊匹配
    const { data: contentMatches, error: err2 } = await supabase
      .from('memories')
      .select('*')
      .ilike('summary', '%' + q + '%')
      .order('timestamp', { ascending: false });

    if (err2) throw err2;

    // 按标题模糊匹配
    const { data: titleMatches, error: err3 } = await supabase
      .from('memories')
      .select('*')
      .ilike('title', '%' + q + '%')
      .order('timestamp', { ascending: false });

    if (err3) throw err3;

    // 合并去重
    const seen = new Set();
    const merged = [];
    [...keywordMatches, ...titleMatches, ...contentMatches].forEach(item => {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    });

    res.json({ success: true, data: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有关键词统计
app.get('/memories/keywords', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('keywords');

    if (error) throw error;

    const keywordCount = {};
    data.forEach(row => {
      if (row.keywords && Array.isArray(row.keywords)) {
        row.keywords.forEach(kw => {
          keywordCount[kw] = (keywordCount[kw] || 0) + 1;
        });
      }
    });

    const keywords = Object.entries(keywordCount)
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count);

    res.json({ success: true, data: keywords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动创建记忆
app.post('/memories', async (req, res) => {
  try {
    const { title, summary, keywords } = req.body;
    if (!summary) {
      return res.status(400).json({ error: '摘要内容不能为空' });
    }

    const { data, error } = await supabase
      .from('memories')
      .insert({
        session_id: 'global',
        title: title || '',
        summary,
        keywords: keywords || [],
        timestamp: new Date().toISOString(),
        conversation_id: 'manual'
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动触发压缩某个会话
app.post('/memories/compress/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { data: messages, error: msgErr } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    if (msgErr) throw msgErr;

    if (!messages || messages.length < 4) {
      return res.status(400).json({ error: '对话内容太少，无需压缩' });
    }

    const conversationText = messages.map(m => {
      const role = m.role === 'user' ? '用户' : 'AI';
      return role + ': ' + m.content;
    }).join('\n');

    const compressPrompt = '你是一个记忆压缩专家。请阅读以下对话内容，完成两件事：\n\n1. 用简洁的语言总结对话的核心内容（不超过150字），保留关键信息和情感要点\n2. 提取3-5个关键词，用于后续检索这段记忆\n\n请严格按以下JSON格式回复，不要包含其他内容：\n{"title": "简短标题（10字以内）", "summary": "压缩后的摘要", "keywords": ["关键词1", "关键词2", "关键词3"]}\n\n对话内容：\n' + conversationText;

    const compressApiKey = process.env.DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY;
    const compressApiUrl = process.env.DEEPSEEK_API_KEY
      ? 'https://api.deepseek.com/v1/chat/completions'
      : 'https://xn--vduyey89e.com/v1/chat/completions';
    const compressModel = process.env.DEEPSEEK_API_KEY
      ? 'deepseek-chat'
      : '[特特价次kiro]claude-opus-4-6';

    const deepseekResponse = await fetch(compressApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + compressApiKey
      },
      body: JSON.stringify({
        model: compressModel,
        messages: [{ role: 'user', content: compressPrompt }],
        temperature: 0.3,
        max_tokens: 500
      })
    });

    if (!deepseekResponse.ok) {
      const errText = await deepseekResponse.text();
      throw new Error('模型API错误: ' + errText);
    }

    const deepseekData = await deepseekResponse.json();
    const replyContent = deepseekData.choices[0].message.content;

    let parsed;
    try {
      const jsonMatch = replyContent.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      parsed = {
        title: '对话记忆',
        summary: replyContent,
        keywords: []
      };
    }

    const { data: memory, error: memErr } = await supabase
      .from('memories')
      .insert({
        session_id: 'global',
        title: parsed.title || '对话记忆',
        summary: parsed.summary,
        keywords: parsed.keywords || [],
        timestamp: new Date().toISOString(),
        conversation_id: 'session_' + sessionId,
        metadata: { source_session: sessionId, message_count: messages.length }
      })
      .select()
      .single();

    if (memErr) throw memErr;

    // 保留最近6条消息，其余标记不可见
    const keepCount = 6;
    const messagesToHide = messages.slice(0, messages.length - keepCount);

    if (messagesToHide.length > 0) {
      const hideIds = messagesToHide.map(m => m.id);
      await supabase
        .from('messages')
        .update({ visible: false })
        .in('id', hideIds);
    }

    res.json({
      success: true,
      data: memory,
      compressed_count: messagesToHide.length
    });
  } catch (err) {
    console.error('压缩记忆失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 更新记忆（编辑关键词、标题、摘要）
app.put('/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, summary, keywords } = req.body;

    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (summary !== undefined) updateData.summary = summary;
    if (keywords !== undefined) updateData.keywords = keywords;

    const { data, error } = await supabase
      .from('memories')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除记忆
app.delete('/memories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('memories')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 启动服务 =====
app.listen(port, () => {
  console.log(`鱼说后端运行在端口 ${port}`);
});
