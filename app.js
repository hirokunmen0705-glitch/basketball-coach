'use strict';

// ── 定数 ──────────────────────────────────────────────
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// ── DOM ───────────────────────────────────────────────
const setupScreen   = document.getElementById('setup-screen');
const mainScreen    = document.getElementById('main-screen');
const apiKeyInput   = document.getElementById('api-key-input');
const saveKeyBtn    = document.getElementById('save-key-btn');
const intervalInput = document.getElementById('interval-input');
const intervalDisp  = document.getElementById('interval-display');
const offenseText   = document.getElementById('offense-text');
const defenseText   = document.getElementById('defense-text');
const playerNumber  = document.getElementById('player-number');
const playerColor   = document.getElementById('player-color');
const startBtn      = document.getElementById('start-btn');
const stopBtn       = document.getElementById('stop-btn');
const video         = document.getElementById('camera');
const canvas        = document.getElementById('capture-canvas');
const phaseLabel    = document.getElementById('phase-label');
const log           = document.getElementById('log');

// ── 状態 ──────────────────────────────────────────────
let apiKey      = '';
let intervalSec = 2;
let prevPhase   = null;
let timerId     = null;
let isAnalyzing = false;

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

  // iOS Safari で音声をアンロック（ユーザー操作中に必ず1回 speak を呼ぶ）
  unlockSpeech();

  // カメラ起動（width指定なし: iOS Safariの OverconstrainedError を防ぐ）
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    video.srcObject = stream;

    // ビデオフレームが届くまで待つ（黒画像をAPIに送らないため）
    await new Promise(resolve => {
      video.addEventListener('loadeddata', resolve, { once: true });
      setTimeout(resolve, 3000); // 3秒タイムアウト
    });

  } catch (e) {
    const httpsHint = (location.protocol !== 'https:' && location.hostname !== 'localhost')
      ? '\n※ HTTPSが必要です。GitHub Pagesで開いてください。'
      : '';
    alert('カメラを起動できませんでした: ' + e.message + httpsHint);
    return;
  }

  setupScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  phaseLabel.textContent = '解析中...';
  phaseLabel.className   = '';
  addLog('▶ 開始', 'log-ok');

  // 解析ループ開始
  timerId = setInterval(analyze, intervalSec * 1000);
  analyze(); // 即座に1回
});

// ── 停止 ──────────────────────────────────────────────
stopBtn.addEventListener('click', () => {
  clearInterval(timerId);
  timerId     = null;
  isAnalyzing = false; // 必ずリセット（再起動時に詰まらないように）
  prevPhase   = null;
  video.srcObject?.getTracks().forEach(t => t.stop());
  window.speechSynthesis.cancel();
  mainScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
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
      const num    = playerNumber?.value.trim();
      const prefix = num ? `${num}番、` : '';
      speak(prefix + (phase === 'offense' ? offenseText.value : defenseText.value));
      addLog(`🔄 → ${phase === 'offense' ? '攻撃' : '守備'}${num ? ` (${num}番)` : ''}`, 'log-change');
    } else if (phase) {
      addLog(`  ${phase === 'offense' ? '攻撃継続' : '守備継続'}`, '');
    }
  } catch (e) {
    addLog('⚠ ' + e.message, 'log-err');
  } finally {
    isAnalyzing = false;
  }
}

// ── フレームをJPEG base64で取得（320x180に縮小） ─────
function captureFrame() {
  canvas.width  = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
}

// ── Gemini プロンプト生成 ──────────────────────────────
function buildPrompt() {
  const num   = playerNumber?.value.trim();
  const color = playerColor?.value.trim();
  if (num || color) {
    const target = [color, num ? `${num}番` : ''].filter(Boolean).join('の');
    return `この画像はバスケットボールの試合をコートサイドから撮影したものです。
${target}の選手を特定して、その選手は今「攻撃」側ですか「守備」側ですか？
「offense」または「defense」の1単語だけで答えてください。その選手が画面に映っていないか判断できない場合は「unknown」。`;
  }
  return `この画像はバスケットボールの試合をコートサイドから撮影したものです。
画像を見て、映っているチームは今「攻撃」と「守備」どちらの状態に近いですか？
「offense」または「defense」の1単語だけで答えてください。判断できない場合は「unknown」。`;
}

// ── Gemini API 呼び出し ────────────────────────────────
async function callGemini(base64) {
  const prompt = buildPrompt();

  // APIキーはヘッダーで渡す（URLに露出させない）
  const res = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64 } }
        ]
      }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }

  const data      = await res.json();
  const candidate = data.candidates?.[0];

  if (!candidate) throw new Error('APIから応答なし');
  if (candidate.finishReason === 'SAFETY') throw new Error('SAFETYブロック');

  const text = candidate.content?.parts?.[0]?.text?.trim().toLowerCase() ?? '';

  if (text.includes('offense')) return 'offense';
  if (text.includes('defense')) return 'defense';
  return null; // unknown はスキップ
}

// ── 音声アンロック（iOS Safari 対策・ユーザー操作中に呼ぶ） ──
function unlockSpeech() {
  const u = new SpeechSynthesisUtterance('');
  window.speechSynthesis.speak(u);
}

// ── 音声出力 ───────────────────────────────────────────
function speak(text) {
  if (!text) return;
  window.speechSynthesis.cancel();
  // cancel() 直後に speak() を呼ぶと iOS Safari で無音になるため 100ms 遅延
  setTimeout(() => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang  = 'ja-JP';
    u.rate  = 1.1;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }, 100);
}

// ── フェーズUI更新 ─────────────────────────────────────
function updatePhaseUI(phase) {
  phaseLabel.textContent = phase === 'offense' ? '⚡ 攻撃' : '🛡 守備';
  phaseLabel.className   = phase;
}

// ── ログ追加（最大50件） ───────────────────────────────
function addLog(msg, cls) {
  const p = document.createElement('p');
  p.textContent = `${timeStr()} ${msg}`;
  if (cls) p.className = cls;
  log.querySelector('.log-hint')?.remove();
  log.appendChild(p);
  // 上限50件を超えたら古いものから削除
  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function timeStr() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => n.toString().padStart(2, '0'))
    .join(':');
}
