"use client";

import { useState, useRef, useEffect } from 'react';

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string>('idle'); // idle, uploading, processing, ready
  const [logs, setLogs] = useState<string[]>([]);
  const [messages, setMessages] = useState<{ role: 'user' | 'bot', text: string }[]>([]);
  const [input, setInput] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showFlushConfirm, setShowFlushConfirm] = useState(false);
  // Secure Storage State
  const [pin, setPin] = useState('');
  const [isLocked, setIsLocked] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const MAGIC_PREFIX = 'VALID-CLARA-KEY-';
  // Encryption helper (XOR)
  const xorCipher = (text: string, pin: string) => {
    let result = '';
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(text.charCodeAt(i) ^ pin.charCodeAt(i % pin.length));
    }
    return btoa(result); // Base64 encode for storage
  };

  const xorDecipher = (encoded: string, pin: string) => {
    try {
      const text = atob(encoded);
      let result = '';
      for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(text.charCodeAt(i) ^ pin.charCodeAt(i % pin.length));
      }
      return result;
    } catch (e) {
      return '';
    }
  };

  useEffect(() => {
    // Check for stored key
    const stored = localStorage.getItem('encrypted_key');
    if (stored) {
      setHasStoredKey(true);
      setIsLocked(true);
      setApiKey(''); // Ensure cleared
    }
  }, []);

  const handleSaveKey = () => {
    if (pin.length !== 6 || !/^\d+$/.test(pin)) {
      alert('PIN must be exactly 6 digits.');
      return;
    }
    if (!apiKey.trim()) {
      alert('Please enter an API Key.');
      return;
    }

    const payload = MAGIC_PREFIX + apiKey;
    const encrypted = xorCipher(payload, pin);
    localStorage.setItem('encrypted_key', encrypted);
    setHasStoredKey(true);
    setIsLocked(false);
    setPin(''); // Clear PIN input
    alert('Key saved securely!');
  };

  const handleUnlock = () => {
    if (pin.length !== 6) {
      alert('PIN must be 6 digits.');
      return;
    }

    const stored = localStorage.getItem('encrypted_key');
    if (!stored) return;

    const decrypted = xorDecipher(stored, pin);
    if (decrypted.startsWith(MAGIC_PREFIX)) {
      const actualKey = decrypted.replace(MAGIC_PREFIX, '');
      setApiKey(actualKey);
      setIsLocked(false);
      setPin('');
    } else {
      alert('Invalid PIN!');
      setPin('');
    }
  };

  const handleLock = () => {
    setApiKey('');
    setIsLocked(true);
  };

  const handleClearKey = () => {
    if (confirm('Remove stored key?')) {
      localStorage.removeItem('encrypted_key');
      setHasStoredKey(false);
      setIsLocked(false);
      setApiKey('');
    }
  };

  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  };

  // Scroll only when messages change
  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages]);

  // KB Stats
  const [dbCount, setDbCount] = useState<number>(0);

  // fetch stats on load
  useEffect(() => {
    fetch('/api/db_status')
      .then(res => res.json())
      .then(data => setDbCount(data.count))
      .catch(() => setDbCount(0));
  }, []);

  const addLog = (message: string) => {
    setLogs(prev => [...prev, message]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleFlush = async () => {
    if (window.confirm("Are you sure you want to remove the current knowledge base? This action cannot be undone.")) {
      try {
        const res = await fetch('/api/flush', { method: 'POST' });
        if (res.ok) {
          setDbCount(0);
          addLog('Knowledge Base Flushed.');
          setStatus('idle');
        }
      } catch (e) {
        console.error(e);
        addLog('Error flushing DB.');
      }
    }
  };

  const handleProcess = async () => {
    if (!file) return;

    setStatus('uploading');
    addLog('Starting upload...');

    const formData = new FormData();
    formData.append('file', file);

    try {
      // Upload
      const uploadRes = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      if (!uploadRes.ok) throw new Error('Upload failed');
      const uploadData = await uploadRes.json();
      addLog(`Uploaded: ${uploadData.filename}`);

      setStatus('processing');
      addLog('Step 1: Analyzing & Appending to Knowledge Base...');

      // Process
      const processRes = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filenames: [uploadData.filename] })
      });

      if (!processRes.ok) throw new Error('Processing failed');
      const processData = await processRes.json();

      addLog(`Generated ${processData.qa_pairs_generated} QA pairs.`);
      addLog('Step 2: Training Compressor (Local SFT)...');
      addLog('Step 3: Finalizing Model...');
      addLog('Knowledge Base Updated.');

      setStatus('ready');

      // Update stats
      const statsRes = await fetch('/api/db_status');
      const stats = await statsRes.json();
      setDbCount(stats.count);

    } catch (error) {
      console.error(error);
      addLog('Error occurred during processing.');
      setStatus('error');
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim()) return;

    const userMsg = input;
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setInput('');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg, api_key: apiKey })
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'bot', text: data.response }]);
    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { role: 'bot', text: "Error connecting to server." }]);
    }
  };

  const handleNewChat = () => {
    setMessages([]);
  };

  return (
    <main className="main-container">
      {/* Background Elements */}
      <div className="blob blob-blue"></div>
      <div className="blob blob-pink"></div>

      <div className="content-wrapper">

        {/* Left Panel: Configuration */}
        <div className="glass-panel">
          <h1 className="title gradient-text">CLaRa Chat</h1>
          <p className="subtitle">
            Advanced RAG with Continuous Latent Reasoning.
            Attach your local knowledge base to train the compressor.
          </p>

          <div>
            <h2 className="section-title">1. Knowledge Base</h2>

            <div className="upload-area">
              <input
                type="file"
                onChange={handleFileChange}
                className="file-input"
              />
              <div style={{ pointerEvents: 'none' }}>
                <p className="placeholder-text">
                  {file ? file.name : "Click to Upload or Drag File"}
                </p>
                <p className="sub-placeholder">.txt, .md, .pdf supported</p>
              </div>
            </div>

            <button
              onClick={handleProcess}
              disabled={!file || status === 'processing' || status === 'uploading'}
              className="btn-primary"
            >
              {status === 'processing' ? 'Processing...' : status === 'uploading' ? 'Uploading...' : 'Add File to Knowledge Base'}
            </button>

            <div style={{ marginTop: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>Total QA Pairs: {dbCount}</span>
              <button
                onClick={handleFlush}
                className="btn-primary"
                style={{ background: '#ef4444', fontSize: '0.7rem', padding: '0.3rem 0.6rem', width: 'auto' }}
              >
                Flush Knowledge Base
              </button>
            </div>

            {/* Secure API Key Storage */}
            <div style={{ marginTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
              <h2 className="section-title" style={{ fontSize: '1rem' }}>OpenRouter API Key</h2>

              {!hasStoredKey ? (
                // Setup Mode
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Paste sk-or-... key here"
                    className="input-field"
                    style={{ fontSize: '0.8rem', padding: '0.5rem' }}
                  />
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="password"
                      maxLength={6}
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      placeholder="Set 6-digit PIN"
                      className="input-field"
                      style={{ fontSize: '0.8rem', padding: '0.5rem', width: '120px' }}
                    />
                    <button onClick={handleSaveKey} className="btn-primary" style={{ flex: 1, padding: '0.5rem', fontSize: '0.8rem' }}>
                      Save & Lock
                    </button>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>Key is stored locally & PIN protected.</span>
                </div>
              ) : isLocked ? (
                // Locked Mode
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ background: '#1f2937', padding: '0.5rem', borderRadius: '4px', color: '#9ca3af', fontSize: '0.8rem', fontStyle: 'italic' }}>
                    Type PIN to unlock key
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="password"
                      maxLength={6}
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      placeholder="Enter 6-digit PIN"
                      className="input-field"
                      style={{ fontSize: '0.8rem', padding: '0.5rem', width: '120px' }}
                      onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                    />
                    <button onClick={handleUnlock} className="btn-primary" style={{ flex: 1, padding: '0.5rem', fontSize: '0.8rem', background: 'linear-gradient(45deg, #10b981, #3b82f6)' }}>
                      Unlock
                    </button>
                  </div>
                </div>
              ) : (
                // Unlocked Mode
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(16, 185, 129, 0.1)', padding: '0.5rem', borderRadius: '4px', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                    <span style={{ color: '#10b981', fontSize: '0.8rem', fontWeight: 'bold' }}>● Key Active</span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button onClick={handleLock} style={{ background: 'none', border: 'none', color: '#fbbf24', cursor: 'pointer', fontSize: '0.8rem' }}>Lock</button>
                      <button onClick={handleClearKey} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.8rem' }}>Clear</button>
                    </div>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>Ready for chat. Lock when done.</span>
                </div>
              )}
            </div>

            {/* Logs Area */}
            <div className="logs-area">
              {logs.length === 0 && <span style={{ color: '#4b5563' }}>System logs will appear here...</span>}
              {logs.map((log, i) => (
                <div key={i} className="log-text">{`> ${log}`}</div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Panel: Chat */}
        <div className="glass-panel chat-container">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 className="section-title" style={{ margin: 0 }}>
              <span className={`status-dot ${status === 'ready' ? 'ready' : 'idle'}`}></span>
              2. Interactive Chat
            </h2>
            <button
              onClick={handleNewChat}
              className="send-btn"
              style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}
            >
              New Chat
            </button>
          </div>

          <div className="messages-list" ref={messagesContainerRef}>
            {messages.length === 0 && (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '0.875rem', textAlign: 'center' }}>
                Chat will be available after<br />knowledge base initialization.
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`message ${m.role}`}>
                {m.text}
              </div>
            ))}
            {/* Removed chatEndRef */}
          </div>

          <div className="input-group">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder="Ask a question..."
              className="input-field"
              disabled={status !== 'ready'}
            />
            <button
              onClick={handleSendMessage}
              disabled={status !== 'ready'}
              className="send-btn"
            >
              ➔
            </button>
          </div>
        </div>

      </div>
    </main>
  );
}
