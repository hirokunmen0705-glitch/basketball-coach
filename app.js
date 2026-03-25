'use strict';

// ── 定数 ──────────────────────────────────────────────
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';
const CAPTURE_W = 480;
const CAPTURE_H = 270;

// ── DOM ───────────────────────────────────────────────
const setupScreen   = document.getElementById('setup-screen');
const mainScreen    = document.getElementById('main-screen');
const apiKeyInput   = document.getElementById('api-key-input');
const saveKeyBtn    = document.getElementById('save-key-btn');
const refPhotoInput = document.getElementById('ref-photo-input');
const refPreviewWrap= document.getElementById('ref-preview-wrap');
const refPreview    = document.getElementById('ref-preview');
const refClearBtn   = document.getElementById('ref-clear-btn');
const refUploadLabel= document.getElementById('ref-upload-label');
const videoFileInput = document.getElementById('video-file-input');
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
let apiKeys        = [];
let keyIndex       = 0;
let keyFailCount   = {};
let intervalSec    = 7;
let prevPhase      = null;
let timerId        = null;
let isAnalyzing    = false;
let rateLimitUntil = 0;
let rateLimitRetry = 6000;
let refPhotoB64    = null;  // 参考写真 base64（jpeg）

// ── 起動時に保存済みデータを復元 ──────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const savedKey   = localStorage.getItem('gemini_api_key');
  const savedRef   = localStorage.getItem('ref_photo_b64');
  const savedNum   = localStorage.getItem('player_number');
  const savedColor = localStorage.getItem('player_color');
  const savedOff   = localStorage.getItem('offense_text');
  const savedDef   = localStorage.getItem('defense_text');

  if (savedKey)   apiKeyInput.value = savedKey;
  if (savedNum)   playerNumber.value = savedNum;
  if (savedColor) playerColor.value = savedColor;
  if (savedOff)   offenseText.value = savedOff;
  if (savedDef)   defenseText.value = savedDef;

  if (savedRef) {
    // data URL prefix が混入していた場合は除去
    refPhotoB64 = savedRef.includes(',') ? savedRef.split(',')[1] : savedRef;
    showRefPreview(`data:image/jpeg;base64,${refPhotoB64}`);
  }
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

// ── 参考写真登録 ───────────────────────────────────────
refPhotoInput.addEventListener('change', () => {
  const file = refPhotoInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    // canvas でリサイズ（送信サイズを抑える）
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const maxW = 400, maxH = 400;
      let w = img.width, h = img.height;
      if (w > maxW || h > maxH) {
        const r = Math.min(maxW / w, maxH / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = c.toDataURL('image/jpeg', 0.8);
      refPhotoB64 = dataUrl.split(',')[1];
      localStorage.setItem('ref_photo_b64', refPhotoB64);
      showRefPreview(dataUrl);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

refClearBtn.addEventListener('click', () => {
  refPhotoB64 = null;
  localStorage.removeItem('ref_photo_b64');
  refPhotoInput.value = '';
  refPreviewWrap.classList.add('hidden');
  refUploadLabel.classList.remove('hidden');
});

function showRefPreview(dataUrl) {
  refPreview.src = dataUrl;
  refPreviewWrap.classList.remove('hidden');
  refUploadLabel.classList.add('hidden');
}

// ── 間隔スライダー ─────────────────────────────────────
intervalInput.addEventListener('input', () => {
  intervalSec = parseFloat(intervalInput.value);
  intervalDisp.textContent = `${intervalSec}秒`;
});

// ── テキスト入力を都度保存 ─────────────────────────────
[playerNumber, playerColor, offenseText, defenseText].forEach(el => {
  el.addEventListener('change', () => {
    const keys = { 'player-number': 'player_number', 'player-color': 'player_color',
                   'offense-text': 'offense_text', 'defense-text': 'defense_text' };
    if (keys[el.id]) localStorage.setItem(keys[el.id], el.value);
  });
});

// ── 開始 ──────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const raw = localStorage.getItem('gemini_api_key') || apiKeyInput.value.trim();
  if (!raw) { alert('Gemini APIキーを保存してください'); return; }
  apiKeys = raw.split(',').map(k => k.trim()).filter(Boolean);
  keyIndex = 0;
  keyFailCount = {};

  unlockSpeech();

  const file = videoFileInput?.files[0];
  if (file) {
    // デバッグ用動画ファイルモード
    video.src = URL.createObjectURL(file);
    video.loop = true;
    video.muted = true;
    await new Promise(resolve => {
      video.addEventListener('loadeddata', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
    video.play();
  } else {
    // 本番: iPhoneカメラ
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

  const mode = refPhotoB64 ? '写真モード' : '番号/色モード';
  addLog(`▶ 開始（${mode}）`, 'log-ok');

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
  if (video.src) { video.pause(); video.src = ''; }
  window.speechSynthesis.cancel();
  mainScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  addLog('■ 停止', 'log-ok');
});

// ── 次の有効キーを返す ────────────────────────────────
function nextActiveKey(current) {
  for (let i = 1; i <= apiKeys.length; i++) {
    const next = (current + i) % apiKeys.length;
    if ((keyFailCount[next] || 0) < 3) return next;
  }
  return (current + 1) % apiKeys.length;
}

// ── フレームキャプチャ → Gemini → 判定 ────────────────
async function analyze() {
  if (isAnalyzing) return;

  const now = Date.now();
  if (now < rateLimitUntil) {
    const remain = Math.ceil((rateLimitUntil - now) / 1000);
    phaseLabel.textContent = `⏳ ${remain}秒待機中`;
    phaseLabel.className = '';
    return;
  }

  isAnalyzing = true;
  try {
    const frameB64 = captureFrame();
    const phase    = await callGemini(frameB64);

    rateLimitRetry = 6000;
    keyFailCount[keyIndex] = 0;
    keyIndex = nextActiveKey(keyIndex);

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
      keyFailCount[keyIndex] = (keyFailCount[keyIndex] || 0) + 1;
      if (keyFailCount[keyIndex] >= 3) {
        addLog(`⚠ key${keyIndex + 1} を除外`, 'log-err');
      }
      keyIndex = nextActiveKey(keyIndex);
      rateLimitUntil = Date.now() + rateLimitRetry;
      rateLimitRetry = Math.min(rateLimitRetry * 2, 60000);
    } else {
      addLog('⚠ ' + e.message, 'log-err');
    }
  } finally {
    isAnalyzing = false;
  }
}

// ── フレーム取得（480×270） ────────────────────────────
function captureFrame() {
  canvas.width  = CAPTURE_W;
  canvas.height = CAPTURE_H;
  canvas.getContext('2d').drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H);
  return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
}

// ── Gemini プロンプト生成 ──────────────────────────────
function buildRequest(frameB64) {
  const parts = [];

  if (refPhotoB64) {
    // 参考写真モード：2枚送り
    parts.push({ text:
      `1枚目はトラッキングしたい選手の参考写真です。
2枚目はバスケットボールの試合をコートサイドから撮影したフレームです。
1枚目の選手を2枚目から探し、その選手が今「攻撃」側か「守備」側かを答えてください。
判断基準：その選手のチームがボールを持っている・相手ゴールへ攻めている場合は offense、相手の攻撃を防いでいる場合は defense。
タイムアウト・ボールデッド・選手が映っていない場合は unknown。
「offense」「defense」「unknown」の1単語のみで答えてください。` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: refPhotoB64 } });
  } else {
    // テキスト説明モード
    const num   = playerNumber?.value.trim();
    const color = playerColor?.value.trim();
    const target = [color, num ? `${num}番` : ''].filter(Boolean).join('の') || 'チーム全体';
    parts.push({ text:
      `この画像はバスケットボールの試合をコートサイドから撮影したフレームです。
${target}の選手が今「攻撃」側か「守備」側かを答えてください。
判断基準：ボールを持っているチーム・相手ゴールへ攻めている方向・選手の動きから判断。
タイムアウト・ボールデッド・対象選手が映っていない場合は unknown。
「offense」「defense」「unknown」の1単語のみで答えてください。` });
  }

  parts.push({ inline_data: { mime_type: 'image/jpeg', data: frameB64 } });
  return parts;
}

// ── Gemini API 呼び出し ────────────────────────────────
async function callGemini(frameB64) {
  const res = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKeys[keyIndex] || apiKeys[0]
    },
    body: JSON.stringify({
      contents: [{ parts: buildRequest(frameB64) }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error?.message || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
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
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
}

// ── 音声出力 ───────────────────────────────────────────
function speak(text) {
  if (!text) return;
  window.speechSynthesis.cancel();
  setTimeout(() => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang  = 'ja-JP';
    u.rate  = 1.1;
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
  return new Date().toTimeString().slice(0, 8);
}
