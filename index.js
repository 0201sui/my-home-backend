import { useState } from 'react';
import './App.css';

function App() {
    const [message, setMessage] = useState('');
    const [response, setResponse] = useState('');
    const [loading, setLoading] = useState(false);

    const sendMessage = async () => {
        if (!message.trim()) return;
        setLoading(true);
        setResponse('');

        try {
            const res = await fetch('https://my-home-backend-9j56.onrender.com/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                const lines = chunk.split('\\\\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.replace('data: ', '');
                        if (jsonStr === '[DONE]') continue;
                        try {
                            const json = JSON.parse(jsonStr);
                            const content = json.choices?.[0]?.delta?.content || '';
                            fullText += content;
                            setResponse(fullText);
                        } catch (e) {}
                    }
                }
            }

            if (!fullText) {
                setResponse('无回复');
            }

        } catch (error) {
            setResponse('? 请求失败');
        }
        setLoading(false);
    };

    return (
        <div className="app">
            <h1>?? 鱼说</h1>
            <div className="chat-box">
                <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="输入消息..."
                    rows={3}
                />
                <button onClick={sendMessage} disabled={loading}>
                    {loading ? '发送中...' : '发送'}
                </button>
                <div className="response-box">
                    <strong>回复：</strong>
                    <p>{response || '等待回复...'}</p>
                </div>
            </div>
        </div>
    );
}

export default App;
