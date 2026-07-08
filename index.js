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
                'Content-Type': 'application/json',
                'Authorization': 'Bearer sk-7uNLb1PGIdrBICkbm2ZB7zXcFhYOkdLquiqoCPVViIJgbSTW'
            },
            body: JSON.stringify({
                model: 'claude-3-sonnet-20240229',
                max_tokens: 1024,
                messages: [{ role: 'user', content: message }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API 错误: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const reply = data.choices[0].message.content;
        res.json({ reply });
    } catch (error) {
        console.error('API 错误:', error.message);
        res.status(500).json({ error: 'AI 服务暂时不可用' });
    }
});

app.listen(port, () => {
    console.log(`后端服务已启动: http://localhost:${port}`);
    console.log(`健康检查: http://localhost:${port}/health`);
    console.log(`数据库测试: http://localhost:${port}/test-db`);
});
