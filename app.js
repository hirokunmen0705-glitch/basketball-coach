'use strict';

// ── 設定 ──────────────────────────────────────────────
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// ── DOM ───────────────────────────────────────────────
const setupScreen   = document.getElementById('setup-screen');
const mainScreen    = document.getElementById('main-screen');
const apiKeyInput   = document.getElementById('api-key-input');
const saveKeyBtn    = document.getElementById('save-key-btn');
const intervalInput = document.getElementById('interval-input');
const intervalDisp  = document.getElementById('interval-display');
const offenseText   = document.getElementById('offense-text');
const defenseText   = document.getElementById('defense-text');
const startBtn      = document.getElementById('start-btn');
const stopBtn       = document.getElementById('stop-btn');
const video         = document.getElementById('camera');
const canvas        = document.getElementById('capture-canvas');
const phaseLabel    = document.getElementById('phase-label');
const log           = document.getElementById('log');

// ── 状態 ──────────────────────────────────────────────
let apiKey       = '';
let intervalSec  = 2;
let prevPhase    = null;   // 'offense' | 'defense' | null
let timerId      = null;
let isAnalyzing  = false;

// ── 起動時に保存済みキーを復元 ─────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('gemini_api_key');
  if (saved) apiKeyInput.value = saved;
});

// ── APIキー保存 ────────────────────────────────────────
saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) { alert('APIキーを入力してください'); return; }
  localStorage.setItem('gemini_api_key', key);
  saveKeyBtn.textContent = '✓ 保存済み';
  setTimeout(() => { saveKeyBtn.textContent = '保存'; }, 1500);
});

// ── 間隔スライダー ─────────────────────────────────────
intervalInput.addEventListener('input', () => {
  intervalSec = parseFloat(intervalInput.value);
  intervalDisp.textContent = `${intervalSec}秒`;
});

// ── 開始 ──────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  apiKey = localStorage.getItem('gemini_api_key') || apiKeyInput.value.trim();
  if (!apiKey) { alert('Gemini APIキーを保存してください'); return; }

  // カメラ起動（背面カメラを優先）
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 } },
      audio: false
    });
    video.srcObject = stream;
  } catch (e) {
    alert('カメラを起動できませんでした: ' + e.message);
    return;
  }

  setupScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  phaseLabel.textContent = '解析中...';
  addLog('▶ 開始', 'log-ok');

  // 解析ループ開始
  timerId = setInterval(analyze, intervalSec * 1000);
  analyze(); // 即座に1回
});

// ── 停止 ──────────────────────────────────────────────
stopBtn.addEventListener('click', () => {
  clearInterval(timerId);
  timerId = null;
  video.srcObject?.getTracks().forEach(t => t.stop());
  mainScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  prevPhase = null;
  addLog('■ 停止', 'log-ok');
});

// ── フレームキャプチャ → Gemini → 判定 ────────────────
async function analyze() {
  if (isAnalyzing) return;
  isAnalyzing = true;

  try {
    const base64 = captureFrame();
    const phase  = await callGemini(base64);

    if (phase && phase !== prevPhase) {
      prevPhase = phase;
      updatePhaseUI(phase);
      speak(phase === 'offense' ? offenseText.value : defenseText.value);
      addLog(`🔄 → ${phase === 'offense' ? '攻撃' : '守備'}`, 'log-change');
    } else if (phase) {
      addLog(`  ${phase === 'offense' ? '攻撃継続' : '守備継続'}`, '');
    }
  } catch (e) {
    addLog('⚠ ' + e.message, 'log-err');
  } finally {
    isAnalyzing = false;
  }
}

// ── フレームをJPEG base64で取得 ───────────────────────
function captureFrame() {
  canvas.width  = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
}

// ── Gemini API 呼び出し ────────────────────────────────
async function callGemini(base64) {
  const prompt = `この画像はバスケットボールの試合をコートサイドから撮影したものです。
画像を見て、映っているチームは今「攻撃」と「守備」どちらの状態に近いですか？
「offense」または「defense」の1単語だけで答えてください。判断できない場合は「unknown」。`;

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64 } }
        ]
      }],
      generationConfig: { maxOutputTokens: 10, temperature: 0 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() ?? '';

  if (text.includes('offense')) return 'offense';
  if (text.includes('defense')) return 'defense';
  return null; // unknown はスキップ
}

// ── 音声出力 ───────────────────────────────────────────
function speak(text) {
  if (!text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang  = 'ja-JP';
  u.rate  = 1.1;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

// ── フェーズUI更新 ─────────────────────────────────────
function updatePhaseUI(phase) {
  phaseLabel.textContent = phase === 'offense' ? '⚡ 攻撃' : '🛡 守備';
  phaseLabel.className   = phase;
}

// ── ログ追加 ───────────────────────────────────────────
function addLog(msg, cls) {
  const p = document.createElement('p');
  p.textContent = `${timeStr()} ${msg}`;
  if (cls) p.className = cls;
  // ヒントを消す
  log.querySelector('.log-hint')?.remove();
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

function timeStr() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
}
