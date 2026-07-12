require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== 健康检查 =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '后端服务正常运行！' });
});

// ===== 会话管理 =====

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

// ===== 核心对话接口（去掉了自动压缩） =====
app.post('/chat', async (req, res) => {
  const { message, session_id, model } = req.body;

  if (!message) return res.status(400).json({ error: '消息不能为空' });
  if (!session_id) return res.status(400).json({ error: '缺少 session_id' });

  try {
    await supabase.from('messages').insert({
      session_id,
      role: 'user',
      content: message,
      visible: true,
      created_at: new Date().toISOString()
    });

    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    let settings = {
      system_prompt: '你是一个温暖、有爱的AI伙伴。',
      temperature: 0.7,
      max_context_rounds: 20,
      max_reply_tokens: 1024
    };
    const { data: settingsData } = await supabase.from('settings').select('*').limit(1).single();
    if (settingsData) settings = settingsData;

    // 加载记忆摘要
    let memoryContext = '';
    const { data: memories } = await supabase
      .from('memories')
      .select('summary')
      .order('timestamp', { ascending: false })
      .limit(5);

    if (memories && memories.length > 0) {
      memoryContext = '以下是之前对话的记忆摘要：\n' + memories.map(m => m.summary).join('\n') + '\n\n';
    }

    // 加载历史消息
    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', session_id)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    const maxRounds = settings.max_context_rounds * 2;
    const recentHistory = history ? history.slice(-maxRounds) : [];

    const systemContent = (settings.system_prompt || '') + '\n\n' + memoryContext;
    const contextMessages = [
      { role: 'system', content: systemContent.trim() },
      ...recentHistory
    ];

    const aiResponse = await callModel(contextMessages, model, settings);

    await supabase.from('messages').insert({
      session_id,
      role: 'assistant',
      content: aiResponse,
      visible: true,
      created_at: new Date().toISOString()
    });

    // 返回当前未压缩消息数量，前端可以用来提醒用户
    const { count } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', session_id)
      .eq('visible', true);

    res.json({ reply: aiResponse, message_count: count });

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

// ===== 记忆宫殿接口 =====

// 获取所有记忆
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

// 搜索记忆
app.get('/memories/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ success: true, data: [] });

    const { data: keywordMatches, error: err1 } = await supabase
      .from('memories')
      .select('*')
      .contains('keywords', [q])
      .order('timestamp', { ascending: false });
    if (err1) throw err1;

    const { data: contentMatches, error: err2 } = await supabase
      .from('memories')
      .select('*')
      .ilike('summary', '%' + q + '%')
      .order('timestamp', { ascending: false });
    if (err2) throw err2;

    const { data: titleMatches, error: err3 } = await supabase
      .from('memories')
      .select('*')
      .ilike('title', '%' + q + '%')
      .order('timestamp', { ascending: false });
    if (err3) throw err3;

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
    const { data, error } = await supabase.from('memories').select('keywords');
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
    if (!summary) return res.status(400).json({ error: '摘要不能为空' });

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

// 手动压缩当前会话（不重复压缩 + 字数控制）
app.post('/memories/compress/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { max_words, delete_after } = req.body || {};
    const wordLimit = max_words || 200;

    // 查找该会话上次压缩的时间点
    const { data: lastMemory } = await supabase
      .from('memories')
      .select('timestamp')
      .eq('conversation_id', 'session_' + sessionId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .single();

    // 获取上次压缩之后的新消息
    let query = supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    if (lastMemory && lastMemory.timestamp) {
      query = query.gt('created_at', lastMemory.timestamp);
    }

    const { data: messages, error: msgErr } = await query;
    if (msgErr) throw msgErr;

    if (!messages || messages.length < 2) {
      return res.status(400).json({ error: '没有新的对话内容需要总结' });
    }

    const conversationText = messages.map(m => {
      const role = m.role === 'user' ? '用户' : 'AI';
      return role + ': ' + m.content;
    }).join('\n');

    const compressPrompt = `你是一个记忆压缩专家。请阅读以下对话内容，完成两件事：

1. 用简洁的语言总结对话的核心内容，严格控制在${wordLimit}字以内，保留关键信息和情感要点
2. 提取3-5个关键词，用于后续检索这段记忆

请严格按以下JSON格式回复，不要包含其他内容：
{"title": "简短标题（10字以内）", "summary": "压缩后的摘要（${wordLimit}字以内）", "keywords": ["关键词1", "关键词2", "关键词3"]}

对话内容：
${conversationText}`;

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
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + compressApiKey
      },
      body: JSON.stringify({
        model: compressModel,
        messages: [{ role: 'user', content: compressPrompt }],
        temperature: 0.3,
        max_tokens: 600
      })
    });

    if (!compressResponse.ok) {
      const errText = await compressResponse.text();
      throw new Error('模型API错误: ' + errText);
    }

    const compressData = await compressResponse.json();
    const replyContent = compressData.choices[0].message.content;

    let parsed;
    try {
      const jsonMatch = replyContent.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      parsed = { title: '对话记忆', summary: replyContent, keywords: [] };
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
        metadata: {
          source_session: sessionId,
          message_count: messages.length,
          message_ids: messages.map(m => m.id)
        }
      })
      .select()
      .single();

    if (memErr) throw memErr;

    // 如果用户选择删除对应聊天记录
    if (delete_after) {
      const hideIds = messages.map(m => m.id);
      await supabase
        .from('messages')
        .update({ visible: false })
        .in('id', hideIds);
    }

    res.json({
      success: true,
      data: memory,
      message_count: messages.length,
      deleted: !!delete_after
    });
  } catch (err) {
    console.error('压缩记忆失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 压缩后单独删除聊天记录
app.post('/memories/delete-source/:memoryId', async (req, res) => {
  try {
    const { memoryId } = req.params;

    const { data: memory, error } = await supabase
      .from('memories')
      .select('metadata')
      .eq('id', memoryId)
      .single();

    if (error) throw error;

    const messageIds = memory?.metadata?.message_ids;
    if (!messageIds || messageIds.length === 0) {
      return res.status(400).json({ error: '没有关联的聊天记录' });
    }

    await supabase
      .from('messages')
      .update({ visible: false })
      .in('id', messageIds);

    res.json({ success: true, deleted_count: messageIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 合并多条记忆
app.post('/memories/merge', async (req, res) => {
  try {
    const { memory_ids, max_words } = req.body;
    const wordLimit = max_words || 200;

    if (!memory_ids || memory_ids.length < 2) {
      return res.status(400).json({ error: '至少选择2条记忆进行合并' });
    }

    const { data: memoriesToMerge, error } = await supabase
      .from('memories')
      .select('*')
      .in('id', memory_ids);

    if (error) throw error;

    const mergeContent = memoriesToMerge.map(m => {
      return `【${m.title || '无标题'}】${m.summary}`;
    }).join('\n\n');

    const allKeywords = [...new Set(memoriesToMerge.flatMap(m => m.keywords || []))];

    const mergePrompt = `你是一个记忆压缩专家。以下是多段已有的记忆摘要，请将它们合并压缩为一段更精简的总结。

要求：
1. 合并后的摘要严格控制在${wordLimit}字以内
2. 保留最重要的信息和情感要点，去除重复内容
3. 从已有关键词中保留最重要的3-5个，也可以新增

请严格按JSON格式回复：
{"title": "合并后的标题（10字以内）", "summary": "合并后的摘要（${wordLimit}字以内）", "keywords": ["关键词1", "关键词2", "关键词3"]}

已有记忆：
${mergeContent}

已有关键词：${allKeywords.join(', ')}`;

    const compressApiKey = process.env.DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY;
    const compressApiUrl = process.env.DEEPSEEK_API_KEY
      ? 'https://api.deepseek.com/v1/chat/completions'
      : 'https://xn--vduyey89e.com/v1/chat/completions';
    const compressModel = process.env.DEEPSEEK_API_KEY
      ? 'deepseek-chat'
      : '[特特价次kiro]claude-opus-4-6';

    const mergeResponse = await fetch(compressApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + compressApiKey
      },
      body: JSON.stringify({
        model: compressModel,
        messages: [{ role: 'user', content: mergePrompt }],
        temperature: 0.3,
        max_tokens: 600
      })
    });

    if (!mergeResponse.ok) {
      const errText = await mergeResponse.text();
      throw new Error('模型API错误: ' + errText);
    }

    const mergeData = await mergeResponse.json();
    const replyContent = mergeData.choices[0].message.content;

    let parsed;
    try {
      const jsonMatch = replyContent.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      parsed = { title: '合并记忆', summary: replyContent, keywords: allKeywords.slice(0, 5) };
    }

    // 创建新的合并记忆
    const { data: newMemory, error: insertErr } = await supabase
      .from('memories')
      .insert({
        session_id: 'global',
        title: parsed.title || '合并记忆',
        summary: parsed.summary,
        keywords: parsed.keywords || [],
        timestamp: new Date().toISOString(),
        conversation_id: 'merged',
        metadata: { merged_from: memory_ids }
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // 删除原始记忆
    await supabase.from('memories').delete().in('id', memory_ids);

    res.json({ success: true, data: newMemory });
  } catch (err) {
    console.error('合并记忆失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 更新记忆
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
    const { error } = await supabase.from('memories').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 导出/导入 =====

// 导出某个会话的聊天记录
app.get('/export/chat/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const { data: session } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      data: {
        session: session,
        messages: messages,
        exported_at: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 导入聊天记录
app.post('/import/chat', async (req, res) => {
  try {
    const { session, messages } = req.body;

    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: '没有可导入的消息' });
    }

    // 创建新会话
    const { data: newSession, error: sessionErr } = await supabase
      .from('sessions')
      .insert({
        name: (session?.name || '导入的对话') + ' (导入)',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (sessionErr) throw sessionErr;

    // 插入消息（更新session_id为新会话）
    const messagesToInsert = messages.map(m => ({
      session_id: newSession.id,
      role: m.role,
      content: m.content,
      visible: m.visible !== undefined ? m.visible : true,
      created_at: m.created_at || new Date().toISOString()
    }));

    const { error: msgErr } = await supabase.from('messages').insert(messagesToInsert);
    if (msgErr) throw msgErr;

    res.json({ success: true, session: newSession, imported_count: messagesToInsert.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 导出所有记忆
app.get('/export/memories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .order('timestamp', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: {
        memories: data,
        exported_at: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 导入记忆
app.post('/import/memories', async (req, res) => {
  try {
    const { memories } = req.body;

    if (!memories || memories.length === 0) {
      return res.status(400).json({ error: '没有可导入的记忆' });
    }

    const memoriesToInsert = memories.map(m => ({
      session_id: 'global',
      title: m.title || '',
      summary: m.summary,
      keywords: m.keywords || [],
      timestamp: m.timestamp || new Date().toISOString(),
      conversation_id: m.conversation_id || 'imported',
      metadata: m.metadata || {}
    }));

    const { error } = await supabase.from('memories').insert(memoriesToInsert);
    if (error) throw error;

    res.json({ success: true, imported_count: memoriesToInsert.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 启动服务 =====
app.listen(port, () => {
  console.log(`鱼说后端运行在端口 ${port}`);
});
