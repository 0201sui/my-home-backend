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

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: '后端服务正常运行！' });
});

app.get('/test-db', async (req, res) => {
    try {
        const { data, error } = await supabase.from('sessions').select('*').limit(1);
        if (error) throw error;
        res.json({ success: true, message: '数据库连接成功！', data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/chat', async (req, res) => {
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }

    try {
        const response = await fetch('https://xn--vduyey89e.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.CLAUDE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-opus-4-6',
                messages: [
                    { role: 'system', content: '你是一个友好的AI助手。' },
                    { role: 'user', content: message }
                ],
                max_tokens: 1024
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('中转站API错误:', data);
            return res.status(response.status).json({ error: data.error?.message || '调用AI失败' });
        }

        const reply = data.choices?.[0]?.message?.content || '无回复';
        res.json({ reply });

    } catch (error) {
        console.error('请求失败:', error);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

app.listen(port, () => {
    console.log(`后端服务已启动: http://localhost:${port}`);
    console.log(`健康检查: http://localhost:${port}/health`);
    console.log(`数据库测试: http://localhost:${port}/test-db`);
});
