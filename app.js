'use strict';

// ── 定数 ──────────────────────────────────────────────
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const CAPTURE_W = 480;
const CAPTURE_H = 270;

// ── DOM ───────────────────────────────────────────────
const setupScreen    = document.getElementById('setup-screen');
const mainScreen     = document.getElementById('main-screen');
const apiKeyInput    = document.getElementById('api-key-input');
const saveKeyBtn     = document.getElementById('save-key-btn');
const intervalInput  = document.getElementById('interval-input');
const intervalDisp   = document.getElementById('interval-display');
const videoFileInput = document.getElementById('video-file-input');
const offenseText    = document.getElementById('offense-text');
const defenseText    = document.getElementById('defense-text');
const playerNumber   = document.getElementById('player-number');
const playerColor    = document.getElementById('player-color');
const startBtn       = document.getElementById('start-btn');
const stopBtn        = document.getElementById('stop-btn');
const video          = document.getElementById('camera');
const canvas         = document.getElementById('capture-canvas');
const phaseLabel     = document.getElementById('phase-label');
const log            = document.getElementById('log');

// ── 状態 ──────────────────────────────────────────────
let apiKeys       = [];   // ローテーション用キー配列
let keyIndex      = 0;
let intervalSec   = 7;
let prevPhase     = null;
let timerId       = null;
let isAnalyzing   = false;
let rateLimitUntil = 0;
let rateLimitRetry = 6000;

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
  const count = key.split(',').filter(k => k.trim()).length;
  saveKeyBtn.textContent = `✓ ${count}件保存`;
  setTimeout(() => { saveKeyBtn.textContent = '保存'; }, 1500);
});

// ── 間隔スライダー ─────────────────────────────────────
intervalInput.addEventListener('input', () => {
  intervalSec = parseFloat(intervalInput.value);
  intervalDisp.textContent = `${intervalSec}秒`;
});

// ── 開始 ──────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const raw = localStorage.getItem('gemini_api_key') || apiKeyInput.value.trim();
  if (!raw) { alert('Gemini APIキーを保存してください'); return; }
  apiKeys = raw.split(',').map(k => k.trim()).filter(Boolean);
  keyIndex = 0;

  unlockSpeech();

  const file = videoFileInput.files[0];
  if (file) {
    // 動画ファイルモード
    const url = URL.createObjectURL(file);
    video.src = url;
    video.loop = true;
    video.muted = true;
    await new Promise(resolve => {
      video.addEventListener('loadeddata', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
    video.play();
  } else {
    // カメラモード
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      video.srcObject = stream;
      await new Promise(resolve => {
        video.addEventListener('loadeddata', resolve, { once: true });
        setTimeout(resolve, 3000);
      });
    } catch (e) {
      const httpsHint = (location.protocol !== 'https:' && location.hostname !== 'localhost')
        ? '\n※ HTTPSが必要です。GitHub Pagesで開いてください。' : '';
      alert('カメラを起動できませんでした: ' + e.message + httpsHint);
      return;
    }
  }

  setupScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  phaseLabel.textContent = '解析中...';
  phaseLabel.className = '';
  addLog(file ? `▶ 開始（動画: ${file.name}）` : '▶ 開始（カメラ）', 'log-ok');

  rateLimitUntil = 0;
  rateLimitRetry = 6000;
  timerId = setInterval(analyze, intervalSec * 1000);
  analyze();
});

// ── 停止 ──────────────────────────────────────────────
stopBtn.addEventListener('click', () => {
  clearInterval(timerId);
  timerId       = null;
  isAnalyzing   = false;
  prevPhase     = null;
  rateLimitUntil = 0;

  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }
  if (video.src) {
    video.pause();
    video.src = '';
  }
  window.speechSynthesis.cancel();
  mainScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  addLog('■ 停止', 'log-ok');
});

// ── フレームキャプチャ → Gemini → 判定 ────────────────
async function analyze() {
  if (isAnalyzing) return;

  // レートリミット待機中
  const now = Date.now();
  if (now < rateLimitUntil) {
    const remain = Math.ceil((rateLimitUntil - now) / 1000);
    phaseLabel.textContent = `⏳ ${remain}秒待機中`;
    phaseLabel.className = '';
    return;
  }

  isAnalyzing = true;
  try {
    const base64 = captureFrame();
    const phase  = await callGemini(base64);

    // 成功したらバックオフをリセット・次のキーへ
    rateLimitRetry = 6000;
    keyIndex = (keyIndex + 1) % apiKeys.length;

    if (phase && phase !== prevPhase) {
      prevPhase = phase;
      updatePhaseUI(phase);
      const num    = playerNumber?.value.trim();
      const prefix = num ? `${num}番、` : '';
      speak(prefix + (phase === 'offense' ? offenseText.value : defenseText.value));
      addLog(`🔄 → ${phase === 'offense' ? '攻撃' : '守備'}${num ? ` (${num}番)` : ''}`, 'log-change');
    } else if (phase) {
      addLog(`  ${phase === 'offense' ? '攻撃継続' : '守備継続'}`, '');
    } else {
      addLog('  選手不明/画外', 'log-hint');
    }
  } catch (e) {
    if (e.status === 429) {
      // キーを次に回してリトライ
      keyIndex = (keyIndex + 1) % apiKeys.length;
      rateLimitUntil = Date.now() + rateLimitRetry;
      addLog(`⚠ レート制限(key${keyIndex+1}) → ${rateLimitRetry / 1000}秒後に再開`, 'log-err');
      rateLimitRetry = Math.min(rateLimitRetry * 2, 60000);
    } else {
      addLog('⚠ ' + e.message, 'log-err');
    }
  } finally {
    isAnalyzing = false;
  }
}

// ── フレームをJPEG base64で取得（480x270） ────────────
function captureFrame() {
  canvas.width  = CAPTURE_W;
  canvas.height = CAPTURE_H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
}

// ── Gemini プロンプト生成 ──────────────────────────────
function buildPrompt() {
  const num   = playerNumber?.value.trim();
  const color = playerColor?.value.trim();
  if (num || color) {
    const target = [color, num ? `${num}番` : ''].filter(Boolean).join('の');
    return `この画像はバスケットボールの試合をコートサイドから撮影したものです。
${target}の選手を特定して、その選手は今「攻撃」側ですか「守備」側ですか？
ボールを保持しているチーム・攻めているゴール方向・選手の動きから判断してください。
「offense」または「defense」の1単語だけで答えてください。その選手が画面に映っていないか判断できない場合は「unknown」。`;
  }
  return `この画像はバスケットボールの試合をコートサイドから撮影したものです。
画像を見て、映っているチームは今「攻撃」と「守備」どちらの状態に近いですか？
ボールの位置・選手の動きから判断してください。
「offense」または「defense」の1単語だけで答えてください。判断できない場合は「unknown」。`;
}

// ── Gemini API 呼び出し ────────────────────────────────
async function callGemini(base64) {
  const prompt = buildPrompt();
  const res = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKeys[keyIndex] || apiKeys[0]
    },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: base64 } }
      ]}],
      generationConfig: { maxOutputTokens: 1024, temperature: 0 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error?.message || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }

  const data      = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('APIから応答なし');
  if (candidate.finishReason === 'SAFETY') throw new Error('SAFETYブロック');

  const text = candidate.content?.parts?.[0]?.text?.trim().toLowerCase() ?? '';
  if (text.includes('offense')) return 'offense';
  if (text.includes('defense')) return 'defense';
  return null;
}

// ── 音声アンロック（iOS Safari 対策） ─────────────────
function unlockSpeech() {
  const u = new SpeechSynthesisUtterance('');
  window.speechSynthesis.speak(u);
}

// ── 音声出力 ───────────────────────────────────────────
function speak(text) {
  if (!text) return;
  window.speechSynthesis.cancel();
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
  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function timeStr() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => n.toString().padStart(2, '0'))
    .join(':');
}
