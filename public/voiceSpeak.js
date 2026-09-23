/*
 * 高音質読み上げ（/api/voice/speak, MeloTTS）の共有部品。
 *
 * 会話系の画面（chat / talk / call / eyes）はどれも、まずブラウザ標準の音声合成
 * （SpeechSynthesis）で読み上げていて、これは無料・低遅延・端末の日本語音声をそのまま使える。
 * ここが提供するのは「もっと自然な声で聞きたい」ときの**追加の選択肢**であって、
 * 置き換えではない。理由は ROADMAP.md フェーズ1-2 の通り、実際に聞き比べてから
 * 既定にするかを決めるべきものだから（品質・遅延・コストのどれも、文章で判断できない）。
 *
 * 各画面はこう使う:
 *   <script src="/voiceSpeak.js" defer></script>
 *   ...
 *   WaketamaVoice.unlock();                          // ユーザーの最初のタップの中で1回呼ぶ（iOS対策）
 *   const ok = await WaketamaVoice.speakHighQuality(text);
 *   if (!ok) { /* 従来のspeechSynthesisにフォールバック * / }
 *
 * 生成した音声はブラウザ内メモリでキャッシュする（同じ台詞を何度も生成しない）。
 * ページを閉じる・再読み込みすると消える——サーバー側には何も保存しない設計を保つため、
 * ここでも意図的に永続化しない。
 */
(function () {
  "use strict";

  var QUALITY_KEY = "sodatsukake_voiceQuality"; // "standard"（既定） | "high"
  var cache = new Map(); // text -> object URL
  var audioEl = null;
  var MAX_CACHE = 40; // 際限なく貯めない。1回のセッションで十分な数。

  function getQuality() {
    try {
      return localStorage.getItem(QUALITY_KEY) === "high" ? "high" : "standard";
    } catch (e) {
      return "standard";
    }
  }

  function setQuality(value) {
    try {
      localStorage.setItem(QUALITY_KEY, value === "high" ? "high" : "standard");
    } catch (e) {
      /* プライベートブラウズ等で書けなくても、設定が既定に戻るだけで動作は続く */
    }
  }

  function ensureAudioEl() {
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.setAttribute("playsinline", "");
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
    }
    return audioEl;
  }

  /**
   * iOS Safariは「ユーザー操作を起点にしない音声再生」を禁止している。
   * 最初のタップ（画面に入る操作など）のイベントハンドラの中で、同期的にこれを呼んでおくと、
   * 以降の speakHighQuality() がタップを経ずに呼ばれても再生できるようになる。
   * SpeechSynthesisの無音発話と同じ狙いの、<audio>版。
   */
  function unlock() {
    try {
      var el = ensureAudioEl();
      var wasMuted = el.muted;
      el.muted = true;
      var p = el.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
      setTimeout(function () {
        try {
          el.pause();
          el.muted = wasMuted;
        } catch (e) {
          /* noop */
        }
      }, 50);
    } catch (e) {
      /* 対応していない環境では黙って諦める。標準の読み上げは影響を受けない */
    }
  }

  function rememberInCache(text, url) {
    if (cache.has(text)) return;
    if (cache.size >= MAX_CACHE) {
      var oldestKey = cache.keys().next().value;
      var oldestUrl = cache.get(oldestKey);
      cache.delete(oldestKey);
      try {
        URL.revokeObjectURL(oldestUrl);
      } catch (e) {
        /* noop */
      }
    }
    cache.set(text, url);
  }

  /**
   * テキストをMeloTTSで読み上げる。
   * 戻り値: 再生できたら true、生成・再生いずれかに失敗したら false
   *  （呼び出し側はfalseのときブラウザ標準にフォールバックすること）。
   *
   * MeloTTS は声質を1種類しか返さない。そこで**再生側で声を分ける**:
   * opts.voice（/api/character が返す voice。pitch と rate を持つ）を渡すと、
   * 再生速度を分身ごとに変え、音程も一緒に動かす（preservesPitch = false）。
   * 高い声の家系ほど少し速く高く、低い家系ほどゆっくり低くなる。
   * 変えすぎると早回しに聞こえるので、0.9〜1.2倍に収めている（voicePlaybackRate）。
   */
  /**
   * 分身の声（pitch 1.0〜2.0 / rate 0.8〜1.4）から、高音質音声の再生倍率を決める。
   * 高さを主に、話す速さを少しだけ混ぜる。声を渡されなければ等倍。
   */
  function voicePlaybackRate(voice) {
    if (!voice || typeof voice.pitch !== "number") return 1;
    var r = 0.9 + (voice.pitch - 1.2) * 0.4 + ((voice.rate || 1) - 1) * 0.25;
    return Math.max(0.9, Math.min(1.2, Math.round(r * 100) / 100));
  }

  function speakHighQuality(text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var t = (text || "").trim();
      if (!t) return resolve(false);

      var settled = false;
      var finish = function (ok) {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      // onendが発火しない環境で無限に待たないための保険（会話が止まらないようにする）
      var guard = setTimeout(function () {
        finish(false);
      }, Math.min(20000, 3000 + t.length * 200));

      var playFromUrl = function (url) {
        try {
          var el = ensureAudioEl();
          var rate = voicePlaybackRate(opts.voice);
          el.playbackRate = rate;
          // 音程ごと動かす（true のままだと速さだけ変わって、声の違いにならない）
          if ("preservesPitch" in el) el.preservesPitch = false;
          if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = false;
          if ("mozPreservesPitch" in el) el.mozPreservesPitch = false;
          el.onended = function () {
            clearTimeout(guard);
            finish(true);
          };
          el.onerror = function () {
            clearTimeout(guard);
            finish(false);
          };
          el.src = url;
          var p = el.play();
          if (p && typeof p.catch === "function") {
            p.catch(function () {
              clearTimeout(guard);
              finish(false);
            });
          }
        } catch (e) {
          clearTimeout(guard);
          finish(false);
        }
      };

      if (cache.has(t)) {
        playFromUrl(cache.get(t));
        return;
      }

      fetch("/api/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, lang: opts.lang || "jp" }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error("speak_failed");
          return res.blob();
        })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          rememberInCache(t, url);
          playFromUrl(url);
        })
        .catch(function () {
          clearTimeout(guard);
          finish(false);
        });
    });
  }

  function stop() {
    if (audioEl) {
      try {
        audioEl.pause();
      } catch (e) {
        /* noop */
      }
    }
  }

  window.WaketamaVoice = {
    getQuality: getQuality,
    setQuality: setQuality,
    unlock: unlock,
    speakHighQuality: speakHighQuality,
    voicePlaybackRate: voicePlaybackRate,
    stop: stop,
  };
})();
