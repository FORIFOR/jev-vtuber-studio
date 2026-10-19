# ホスト音声の演技パイプライン（SpeechDirector / VoiceQualityRouter / 反応音ライブラリ）

ホストの声に「間」「強さ」「速さ」と短い無言の反応音を付けるための仕組みです。既定ではすべて無効（`SPEECH_DIRECTION=off`、`REACTION_AUDIO=false`、`PHRASE_CACHE=false`）で、VOICEVOX / Supertonic 3 のホスト音声は従来の `ReplyVoice` をそのまま通ります（HTTP呼び出し・キャッシュ・Jev要求は同一）。有効にするのは `npm run voice:bench` と Studio の数値で改善を確認してからにしてください。

この演出は**承認済みの文章を1文字も変えません**。別の声・有料サービスへの自動切り替えもしません（[COMMENT_REPLY.md](COMMENT_REPLY.md) の「別の声へ切り替えない」規則はそのままです）。

## ノアの採用音声（2026-09-28）

**AivisSpeech「コハク」／スタイル「ノーマル」（style id `1878365376`）**。ローカル合成（API の従量課金なし）で、AivisSpeech のアプリを開いてから配信を始める。

- 選定：コハク（4スタイル）、まお（6スタイル）、凛音エル（5スタイル）、VOICEVOX 小夜/SAYO・櫻歌ミコ、Gemini Flash-Lite のオリジナル声を同じ台詞で試聴し、運営者が決定（一度まお／せつなめにしたのち、コハクに戻した）。
- 利用条件：ACML 1.0（AivisHub、制作：オズチャット -Oz Chat- ほか）。**クレジット表記「AivisSpeech：コハク（オズチャット）」が必要**（配信画面右下に自動表示。概要欄にも記載）。
- 設定：`REPLY_TTS_PROVIDER=aivisspeech`、`AIVIS_STYLE=1878365376`、`AIVIS_CREDIT=AivisSpeech：コハク（オズチャット）`（実際の値は `data/settings.json`。Git 管理外）。
- 読み：名前「夜澄」はエンジンが誤読するため、台本では「よすみ」と書く（読み方は未確定）。「VTuber」は「ブイチューバー」と書く。
- 声を変えたときは、Studio でリハーサルを聞いて確認してからライブを開始する（別の声への自動切り替えはしない）。

## 口形と音声の同期

ホストの WAV には任意の `lipSync`（version 1、音声内の開始・終了ミリ秒、母音と開口の強さ）が付きます。VOICEVOX は `/audio_query` の音素長、話速、前後無音、句読点の間、疑問語尾を使い、[公式 decoder のフレーム丸め](https://github.com/VOICEVOX/voicevox_engine/blob/master/voicevox_engine/tts_pipeline/tts_engine.py)に合わせます。

AivisSpeech は[音素長を常にダミーの 0.0 として返す仕様](https://github.com/Aivis-Project/AivisSpeech-Engine/blob/master/voicevox_engine/tts_pipeline/model.py)です。そのため、エンジンが返した読みの母音列を WAV の有音区間へ配分した**推定**（`source: reading-estimate`）を使います。個々の発音を実測した時刻ではありません。漢字へ疑似母音を割り当てる処理は使いません。

複数チャンクを結合するときは、無音のトリム量、チャンク間の間、反応音の採用・削除後の位置を反映します。再生側は `AudioContext.currentTime` と実際の WAV 再生開始時刻との差で口形を選び、準備・ACK 待ち・音声停止中に時計を進めません。無音と閉口音では口を閉じ、コメント読み上げはノアの口を動かしません。読み情報のない TTS・録音済みフレーズ・反応音は既存の音量に応じた口形を使います。

音声 API の呼び出し回数、声、音声バイト列、キャッシュのキー、演技設定は変わりません。タイムラインは最大45秒・4,000区間に制限され、不正なメタデータは音声再生を失敗させず破棄します。実装は `src/speech-timing.mjs`、再生時計は `public/speech-visemes.mjs`、回帰テストは `test/speech-timing.test.mjs` です。

## 1. パイプライン

```
LLM が発話文を生成
      │
Jev.speech()  ── 既存のゲート（safe / private / injection / … / novel・progress）で承認
      │           jev モードだけ、同じ要求に演技の質問（強さ・速さ・終わり方・反応音・区間ごとの reaction）を相乗り
      ▼
SpeechDirector.plan()（src/speech-director.mjs・純粋関数）
      │  承認文 → 最大2パート → 各パート最大3チャンク（先頭の感動詞 / 「、」で1回分割）
      │  チャンクごとに family・intensity・pace・終わり方・ポーズ、ターン全体で反応音1つまで、表情ビート
      │  assertCovers(): チャンクをつなぐと承認文と完全一致しなければ PLAN_INVARIANT
      ▼
DirectedVoice / VoiceQualityRouter（src/voice-router.mjs）
      │  CACHE   ── 同じ声・同じ描画キーで作った定型フレーズの完全一致だけ
      │  LOCAL   ── 設定した1つのエンジン（VOICEVOX / AivisSpeech / Style-Bert-VITS2 / Supertonic 3）
      │  PREMIUM ── 無効（null）。コードもキーもありません
      ▼
音声バス（src/audio-bus.mjs + src/wav.mjs）
      │  1パート = 1つの PCM16 モノラル WAV（発話・正確な無音・予定した反応音を含めて組み立て）
      │  この長さが maxTurnAudioMs の上限値になる
      ▼
公開時の finalize()
      │  Effects のクールダウン後の reaction と ClipGovernor で、反応音を「残す」か「外す」だけ
      │  pre 反応音を残したら leadMs = 0、ビートとマウス窓の時刻を確定
      ▼
/stage（音声・アバター・VTube Studio が同じ reaction / intensity で動く）
```

パート（最大2、合計220文字）、ACK、`/audio` ルート、`engine.audio` は最大1件、8秒の再生開始期限は従来のままです。

## 2. モード（SPEECH_DIRECTION）

| 値 | Jevに追加で聞くこと | コスト | 演技の決め方 |
|---|---|---|---|
| `off`（既定・互換用） | なし | 従来と同じ | 演出なし。VOICEVOX / Supertonic は従来の経路。AivisSpeech / SBV2 は常にルーター経由（文字数上限で分割するため）だが、演技は neutral 固定 |
| `reaction`（**本番の推奨**。ベンチマークと一貫性テストの後に有効化） | **なし**（Jevの質問・要求は off と同一） | ローカルCPUのみ（分割・音声組み立て）。エンジン呼び出しはパートあたり最大2〜3回に増えることがある | 既存の `reaction` 答えを VOICE_ACTING 表で声に変換。強さ・速さは表の既定値と句読点から |
| `jev`（実験的・表現重視） | 最大7つの choice 質問（`delivery_intensity` / `delivery_pace` / `delivery_ending` / `delivery_nonverbal` / `seg1..3_reaction`） | 同じ Jev.speech 要求に相乗り（往復は増えない）。要求本文と Jev の処理時間が増える | Jev の答えを信頼度しきい値で採用し、足りない分は表の既定値 |

`jev` モードの質問はゲートの外で1つずつ検証します。答えが不正・欠落していても、発話の承認/却下・例外・Jevの失敗カウントには一切影響せず、既定値を使って `defaulted` と記録されます。追加で48000バイトの Jev 本文上限を超える場合は、演技の質問を付けずに従来の要求だけを送ります。ゲートの質問・しきい値は変わりません。

採用しきい値（`readDelivery`）：
- 強さ：信頼度 ≥ .55。`high` は本文に「！」があるか reaction が laugh / shock / excited / surprised のときだけ。ほかは `mid` に下げる
- 速さ・終わり方：信頼度 ≥ .5（終わり方は発話の最後のチャンクだけに適用）
- 反応音：信頼度 ≥ .6 かつ `warranted` ≥ .7。それ以外は `none`
- 区間 reaction：信頼度 ≥ .5 かつ Jevに提示するプリセット名。それ以外は直前の区間を引き継ぐ。区間0は常にゲートの `reaction`

`REACTION_AUDIO=true` と `PHRASE_CACHE=true` は `SPEECH_DIRECTION` が `off` 以外のときだけ設定できます（off のままだと起動時に設定エラー）。デモモードは Jev・TTS を呼ばず、キーワード規則（`demoDelivery`）とブラウザ音声だけで動きます。

### 反応音の予算（MAX_REACTION_AUDIO_MS）

発話本体は `MAX_TURN_AUDIO_MS`（既定18000）以内、反応音（クリップとその前後の間）は **`MAX_REACTION_AUDIO_MS`（既定1200、0〜3000）以内**という別々の契約です。1ターンの絶対上限は両者の合計です。予算を超える反応音はパートの組み立て時に外され（`clipSkipped: 'reaction_budget'`）、発話は反応音なしで流れます。クリップ長の上限（laugh_big 2500 ms など）に頼らず、この値で保証します。

### 実配信までの順序

1. AivisSpeech / Style-Bert-VITS2 / VOICEVOX を実機で接続
2. `npm run voice:bench`（40文の聞き比べ＋一貫性テスト）→ 勝者を**1つだけ**ホストの声に固定（途中で別エンジンへ切り替えない）
3. `SPEECH_DIRECTION=reaction` → `REACTION_AUDIO=true` → `PHRASE_CACHE=true`（短い定型反応だけ、同じ声で事前生成したもの）の順に有効化
4. 実試聴（リハーサル）→ OBS ローカル録画30分で、別人に聞こえた回数・感情遷移・TTS失敗・発音ミス・反応→音声開始 p50/p95・RTF・CPU/GPU・途中切断・反応音との音量差を確認
5. 問題がなければ限定公開の YouTube へ

**有効にする前に** `npm run voice:bench -- --confirm-local --directed` で、演出あり/なしの TTFA（最初の音声までの時間）・RTF・聞き比べを測ってください。

## 3. 表

### VOICE_ACTING（public/voice-acting.mjs）

感情の語彙は Jev の `reaction` プリセットだけです。声とアバターは同じ名前を使うので食い違いません。大きい演技（laugh / excited / shock）は代替プリセットと同じ声を共有するため、公開時に Effects が shock → surprised へ下げても、すでに合成した声と矛盾しません（テストで保証）。

| プリセット | family | intensity | pace | 反応音（reaction モード） |
|---|---|---|---|---|
| neutral | neutral | mid | normal | — |
| nod | calm | mid | normal | — |
| happy | joy | mid | normal | — |
| laugh | joy | mid | normal | laugh_big |
| excited | joy | mid | normal | breath_in |
| surprised | surprise | high | fast | — |
| shock | surprise | high | fast | gasp |
| embarrassed | shy | low | slow | laugh_small |
| thinking | think | low | slow | hmm |
| troubled | worry | low | slow | breath_out |
| listen | —（声なし・ローカル専用） | — | — | — |

チャンク単位の補正（`chunkDeliveryFor`、生放送と事前生成で共通の唯一の関数）：
- 先頭の感動詞（「えっ、」「わあ！」など）や「！」で終わるチャンクは強さを1段上げる
- 感動詞で family が surprise / joy なら速さは fast
- 「…」「〜」で終わるチャンクは速さを1段下げる

強さは音量にも反映されます（`INTENSITY_DB`：low −2 dB / mid 0 / high +1.5 dB、発話は −20 dB RMS に正規化）。アバター側は `INTENSITY_GAIN`（low .7 / mid 1 / high 1.25）。

### NONVERBAL（無言の反応音クラス）

| クラス | 位置 | jev モードで合わせてよい reaction | 最長 | クールダウン | 音量 |
|---|---|---|---|---|---|
| gasp | pre（パート0の前） | shock, surprised | 800 ms | 8 s | −24 dB |
| laugh_small | post（最終パートの後） | happy, laugh, embarrassed, nod, excited | 1500 ms | 30 s | −24 dB |
| laugh_big | pre | laugh | 2500 ms | 30 s | −24 dB |
| breath_in | pre | excited, neutral, nod, thinking, happy, surprised | 1000 ms | 20 s | −30 dB |
| breath_out | post | troubled, thinking, neutral, nod, happy | 1200 ms | 45 s | −30 dB |
| sigh | post | troubled, thinking | 1500 ms | 45 s | −30 dB |
| hmm | pre（口の開きを .2 に抑える） | thinking, nod, neutral | 1500 ms | 30 s | −24 dB |

- 最短はすべて80 ms。反応音どうしは最低8秒あける（`ClipGovernor`）。クールダウンは合成時と公開時の2回確認し、実際に公開したときだけ記録
- 1ターンに反応音は1つまで。pre はパート0、post は最終パート
- 公開時の互換：reaction モードはクールダウン後の reaction が同じ VOICE_ACTING 反応音を持つこと、jev モードは上表の reaction に含まれること。合わなければ**外すだけ**（laugh_big → laugh_small のような差し替えはしない。位置が違うため）
- 本文がすでにその音を含むときは付けない（「あはは」の後の笑い声、「うーん」の前の hmm、「はぁ」の後の sigh など）
- パートごとの予算（`budgetMs`）を超える反応音は組み立て時に外すので、反応音が原因で「Turn audio too long」になることはありません

### ポーズ

| 項目 | 長さ |
|---|---|
| チャンク末尾 `continue`（「、」「っ」で終わる） | 30 ms |
| チャンク末尾 `beat`（「。」「！」「？」「」」で終わる） | 140 ms |
| チャンク末尾 `hold`（「…」「〜」「ー」で終わる） | 280 ms |
| 感動詞の後（surprise / joy / その他） | 120 / 100 / 150 ms |
| 1境界の上限 / 1パートの合計上限 | 300 ms / 600 ms（超えたら比例縮小） |
| 文字数上限による分割の継ぎ目 | 20 ms |
| pre 反応音と発話の間 / 発話と post 反応音の間 | 60 ms / 80 ms |
| パート末尾（`tailMs` = 終わり方のポーズ − 60 ms） | continue 0 / beat 80 / hold 220 ms（上限300） |
| パート間（試聴の連結） | 60 ms |

### エンジンごとのパラメータ対応（src/tts-adapters.mjs）

速さ倍率 `PACE_MULT`：slow .92 / normal 1 / fast 1.08。

| エンジン | 1回の最大文字数 | 声（family） | 強さ | 速さ | 触らないもの |
|---|---|---|---|---|---|
| VOICEVOX | 200 | `HOST_STYLE_MAP` のスタイルID、なければ `VOICEVOX_SPEAKER` | intonationScale .9 / 1 / 1.15 | speedScale = VOICEVOX_SPEED × 倍率（.5〜2） | volumeScale は .9 固定 |
| AivisSpeech | 200 | `HOST_STYLE_MAP` のスタイルID、なければ `AIVIS_STYLE` | intonationScale = AIVIS_INTONATION × .8 / 1 / 1.25（0〜2） | speedScale = AIVIS_SPEED × 倍率（.5〜2）、tempoDynamicsScale = AIVIS_TEMPO × .9 / 1 / 1.15（0〜2） | pitchScale（0のまま）、kana（エンジンが返した値のまま） |
| Style-Bert-VITS2 | 100 | `HOST_STYLE_MAP` のスタイル名、なければ `SBV2_STYLE` | style_weight = SBV2_STYLE_WEIGHT × .7 / 1 / 1.5（0〜5） | length = 1 / (SBV2_SPEED × 倍率)（.5〜2）、sdp_ratio .15 / .2 / .3 | noise .6、noisew .8、language JP、auto_split false。encoding / assist_text / reference_audio_path は送らない |
| Supertonic 3 | 300 | なし（`SUPERTONIC_VOICE` 固定） | なし（音量差のみ） | speed = SUPERTONIC_SPEED × 倍率（**.7以上**〜2） | 表現タグ（`<laugh>` など）は使わない。steps は品質設定で描画キーに入らない |

文字数上限を超えるチャンクは「、」などの区切りで分割し、つなぐと元の文字列に完全一致することを確認します。

### HOST_STYLE_MAP

7つの voice family（neutral, calm, joy, surprise, shy, think, worry）をキーにした JSON です。10個のプリセットではなく family に対応させるので、試聴するスタイルが少なく、大きい演技と代替が同じスタイルになります。値は ID 方式のエンジン（VOICEVOX / AivisSpeech）では 0〜2147483647 の整数、名前方式（SBV2）では文字列です。書いていない family は既定のスタイルを使います。

```sh
# AivisSpeech：驚きだけ別スタイル（ID は /speakers の styles[].id。31ビットの大きな整数）
HOST_STYLE_MAP={"surprise":888753761}
# Style-Bert-VITS2（JVNV モデル）：style2id のスタイル名
HOST_STYLE_MAP={"joy":"Happy","surprise":"Surprise","worry":"Sad"}
```

SBV2 では、対応表と `SBV2_STYLE` のスタイル名がモデルの `style2id` にすべて存在しないと検出・試聴が失敗します（`SBV2 style not found`）。VOICEVOX では対応表の全スタイルを warm-up 時に `initialize_speaker` します。

## 4. Jevゲートとの整合（なぜ未承認の言葉が放送されないか）

1. **合成するのは承認済みの文章だけ**：SpeechDirector は承認文を部分文字列に区切るだけで、追加・削除・並べ替えをしません。`assertCovers()` と `planUnits()` がチャンクの連結＝承認文を確認し、違えば `PLAN_INVARIANT` をエンジン呼び出しの前に投げます。Jev に送る区間も承認対象の文章の部分文字列です。
2. **定型フレーズの置き換えは完全一致だけ**：キャッシュを使うのは、正規化したチャンク（またはパート全体）が登録フレーズと完全一致し、かつ**同じ声（identity16）と同じ描画キー**で作ったテイクだけです。描画キー = sha256([エンジンID, 声の identity, resolve(delivery)])。URL・品質設定は含みません。事前生成と生放送は同じ関数で計算します（パリティテスト）。正規化は NFKC・チルダ類 → 〜・空白除去・末尾の「、。,.」除去だけで、かな・ー・！？は畳みません（「えっ！？」は「えっ」に一致しない）。前方一致・部分一致・あいまい一致はありません。
3. **反応音は言葉を含まない**：固定の7クラスだけ。運営者が `attest:"nonverbal"` を付けて登録した WAV のみで、`text` 欄を持てず、クラスごとの長さ上限があり、試聴リールで聞く必要があります。TTS が反応音を作ることはありません。「えっ」は言葉なので反応音ではなく定型フレーズ扱いです。
4. **ライブラリの指紋は試聴確認の一部**：`library.fingerprint()` は設定の指紋（checkFingerprint）に含まれます。ファイルが1つ変わるだけで試聴・「聞こえた」・OBS確認・リモート準備がリセットされます。
5. **試聴用の文は試聴専用**：表現リールのスタイル見本文（`AUDITION_TEXT`）はリハーサルでだけ合成し、放送経路には入りません。

## 5. ライブラリ（data/voice/）

`data/` は gitignore 対象です。ディレクトリは 0700、ファイルは 0600。書き込みは一時ファイル → rename の原子的更新で、WAV を先に書いてから manifest を更新します。

```
data/voice/
  phrases.json                     運営者が追加する許可フレーズ（任意）
  clips/
    manifest.json                  反応音の一覧
    gasp-1.wav, laugh_small-1.wav …
  phrases/
    <identity16>/                  声ごと（エンジン＋スタイル/モデル）のディレクトリ
      manifest.json
      <16桁hex>.wav …
```

`clips/manifest.json`：

```json
{ "version": 1, "clips": [
  { "id": "gasp-1", "cls": "gasp", "file": "gasp-1.wav", "sha256": "<64桁hex>", "attest": "nonverbal", "gainDb": 0 }
] }
```

`phrases/<identity16>/manifest.json`：

```json
{ "version": 1, "identity16": "<16桁hex>", "engine": "aivisspeech", "entries": [
  { "id": "<16桁hex>", "text": "ありがとう！", "norm": "ありがとう!", "renderKey": "<64桁hex>", "preset": "happy",
    "source": "tts", "file": "<id>.wav", "sha256": "<64桁hex>", "ms": 820, "createdAt": "2026-09-26T00:00:00.000Z" }
] }
```

録音したフレーズは `"source": "recorded", "attest": "exact-text"` になります。

検査（1件ずつ。不合格の項目は理由付きで除外し、他は読み込む）：
- manifest 256 KiB 以下、ファイル 2 MB 以下、シンボリックリンク不可、ライブラリ外を指す実パス不可、sha256 一致
- 反応音：最大32件、1クラス4テイクまで、長さ 80 ms〜クラス上限、無音・クリップ（1%以上）不可。WAVE_FORMAT_EXTENSIBLE は反応音の取り込みでだけ許可
- フレーズ：最大128件、1フレーズ5テイクまで、120〜3000 ms、1文字あたり40〜400 ms、許可リストにあり、プリセットが許可リストの presets に含まれる
- 合計 120 秒まで。テイクが複数あれば順番に使い、同じテイクを連続させません

### 許可リスト

- `config/phrases.json`（コミット済み・文章だけ）：ありがとう！ / こんばんは！ / ナイス！ / えっ！？ / やったー！ / ちょっと待って！ / なるほど〜 / うんうん / 本当に？ / えっ、 / あっ、 / よかったぁ〜！
- `data/voice/phrases.json`（任意）：同じ形式 `[{"text": "…", "presets": ["happy"]}]` で追加。どちらも24文字以内・1文・個人情報/インジェクション/タグ/URLなし・プリセットは Jev に提示する名前だけ

### npm run voice:library

Jev・LLM は呼びません。表示するのは件数・理由・パスだけで、設定値や秘密は出しません。

```sh
# 現在の声で許可フレーズを事前生成（ループバックのエンジンだけ。TTS上限を1テイク1回消費）
npm run voice:library -- prerender --confirm-local --dry-run      # 予定の呼び出し回数だけ表示
npm run voice:library -- prerender --confirm-local --takes=3 --presets=happy,surprised
npm run voice:library -- prerender --confirm-local --only=ありがとう！ --force

# 自分で用意した無言の反応音を登録（言葉を含まないことを運営者が確認して宣言）
npm run voice:library -- import-clip --class=gasp --file=~/voice/gasp.wav --attest-nonverbal --gain-db=-2

# 人が録音した定型フレーズ（許可リストの文と完全に同じ発話であることを宣言）
npm run voice:library -- import-phrase --text=ありがとう！ --preset=happy --file=~/voice/thanks.wav --attest-exact-text

npm run voice:library -- verify        # 再読み込みして状態表示。除外があれば終了コード1
npm run voice:library -- list          # クラス別・声別の件数
npm run voice:library -- remove --id=gasp-1
```

- VOICEVOX は1テイク、他のエンジンは既定3テイク。品質チェック（無音・クリップ・長さ・1文字あたりの長さ）に落ちたテイクは報告して飛ばし、繰り返し再生成しません
- 事前生成したフレーズは、その声（identity）と描画キーでしか使われません。`REPLY_TTS_PROVIDER`・スタイル・モデル・`HOST_STYLE_MAP`・速さ等を変えたら作り直してください（URLやSupertonicのsteps変更だけなら使い続けられます）

### 読み込みのタイミング

- サーバー起動時、`/api/setup/rehearse`（実試聴）の開始時、設定画面の「反応音ライブラリを再読み込み」（`POST /api/setup/library {"action":"reload"}`、停止中・設定ロック中）の3つだけ
- **番組中は読み込みません**。ファイルを置き換えても次の再読み込みまで反映されません
- 内容が変われば指紋が変わり、試聴確認をやり直す必要があります

## 6. 実試聴（リハーサル）

- playground プロファイル：従来どおり1回の `synthesize(text)`
- talk プロファイル：生放送と同じ director → router → バス → finalize（新しい Effects）でパートごとに合成し、`maxTurnAudioMs` を確認して60 msで連結。チェック名と数（3/4）は従来どおり
- `SBV2_MODEL` に amitaro / koharune を含み `SBV2_CREDIT` が空なら `CREDIT_REQUIRED` で失敗します

**表現リール**（`SPEECH_DIRECTION` が off 以外の live モードだけ）：
- `HOST_STYLE_MAP` に対応のある全スタイル × mid / high（最大14回、試聴専用の固定文。エンジン呼び出しと TTS 上限を消費）
- `REACTION_AUDIO=true` なら登録済みの全反応音
- `PHRASE_CACHE=true` なら現在の声の全フレーズテイク

放送されうるものは全部入れるので、リールは短縮しません。リールがある場合、「聞こえた」（`POST /api/setup/heard`）には返答音声・コメント音声に加えて**リールを最後まで再生したこと（`libraryHeard`）**が必要です。「聞いた」記録は保存せず、試聴のたびに全部を聞き直します。

## 7. 運用

### エンジンの状態

- **サーキットブレーカー**（エンジンごと）：DOWN（接続失敗・タイムアウト・5xx）か MISMATCH（別のサービスが応答）が2回続くと15秒オープン。以後は倍々で最大60秒。オープン明けは1回だけ試行（half-open）。REJECTED（4xx・入力不正）と中断は数えません
- **ヘルス/身元確認**：Supertonic はパートごとに `/v1/health`、AivisSpeech と SBV2 は60秒キャッシュの身元確認（失敗で破棄）、VOICEVOX はパートごとの確認なし
- **warm-up**：番組開始時と試聴の合成ステップ開始時。VOICEVOX / AivisSpeech は使うスタイルを `initialize_speaker`、SBV2 は初回ロードが遅いので「あ」を1回合成（TTS上限を1回消費）。pass-through とデモでは何もしません。warm-up の失敗はサーキットを開きません
- **事前スキップ**：サーキットがオープン中（`voice.available()` が false）は、TalkEngine が LLM と Jev を呼ばずに準備を保留し、オープン終了まで再試行を待ちます（`voice_unavailable_skip`）。有料の生成を無駄にしません
- **ギャップ保持**：パート0が全部キャッシュでパート1がまだ合成中のとき、パート0の公開を最大1.5秒待って、パート間の無音を減らします。待った時間は `first_part_hold_ms` に記録
- **呼び出し数**：エンジンごとに同時実行1のキューで、1パートの呼び出しはまとめて投入（次ターンの先読みが割り込まない）。呼び出しはパート0で最大2回、他は最大3回。TTS 上限（`MAX_TTS_CALLS`）はエンジン呼び出しが1回以上あるパートごとに1回予約。キャッシュだけのパートは予約しません

### 指標と Studio

追加した指標（既存の llm_ms / output_judge_ms / tts_ms / comment_tts_ms は変更なし）：`first_audio_ready_ms`、`publish_to_start_ms`、`dead_air_ms`、`mid_turn_gap_ms`、`first_part_hold_ms`、`tts_rtf_permille`、カウンタ `tts_tier_cache` / `tts_tier_local` / `tts_engine_calls` / `reaction_clip_used` / `reaction_clip_dropped` / `voice_unavailable_skip` / `speech_direction_failure` / `bus_finalize_error`。

Studio（運営画面のみ。`/stage` には出しません）：
- **VOICE** カード：エンジンと状態、サーキット（closed / open 残り秒 / half-open）、premium（disabled）、演出モード、pass-through、フレーズ hit/miss、反応音 used/dropped、最後のエラーコード、ライブラリ（hash8・件数）
- **DELIVERY** カード：直近パートの reaction・強さ・出どころ（reaction / jev / demo-rule）、チャンク（文字数:reaction/速さ/終わり方）、エンジン、cache/local 数、反応音、leadMs
- イベント：`VOICE tier`、`VOICE ✕`（サーキット）、`VOICE warm`

### 別の声へは切り替えない

エンジンの失敗・不一致・サーキットオープン時は、そのパートを失敗させ、既存のバックオフ・停止規則に従います。別のエンジン・別の声・有料サービスへは自動でも手動の設定でも切り替えません（`HOST_TTS_FALLBACK` はありません）。エラーコード：`TTS_ENGINE_DOWN` / `TTS_ENGINE_MISMATCH` / `TTS_REJECTED` / `SUPERTONIC_NOT_READY` / `PLAN_INVARIANT` / `CREDIT_REQUIRED`。表示メッセージに本文・URL・設定値は含めません。

## 8. エンジンの導入メモ

エンジン・モデル・録音はこのリポジトリに同梱せず、自動ダウンロードもしません。どのエンジンも **Tailscale やインターネットへ公開しないでください**（スマホからは 8788 の専用リモコンだけを使います）。

### AivisSpeech Engine（`REPLY_TTS_PROVIDER=aivisspeech`）

- 既定 `http://127.0.0.1:10101`。VOICEVOX（:50021）と同時に動かせます。初回起動で約900 MBのモデルをダウンロードします
- 身元確認：`/version` と `/engine_manifest` の name（`AivisSpeech Engine`）＋ uuid。VOICEVOX も同じルートに応答するため、名前と uuid が一致しなければ `TTS_ENGINE_MISMATCH`
- スタイルIDは31ビットの大きな整数（例 888753760）。`AIVIS_STYLE` に `/speakers` の ID を設定（0のままだと試聴できません）。検出画面に候補が出ます
- `kana` はエンジンが返したまま送り返します。`pitchScale` は0のまま（変えると音質が落ちる）
- intonation / tempo は2を超えると黙って既定に戻るため、設定範囲は0〜2に制限しています
- 推論はエンジン内で直列です。こちらも同時実行1で送ります
- ライセンス：エンジンは LGPL。モデルごとに ACML / ACML-NC などが付きます。**ACML-NC は収益化した配信を含まない可能性が高い**ので、`/speaker_info` の規約本文を確認してください。クレジットは `AIVIS_CREDIT`（空なら「Host: AivisSpeech」）

### Style-Bert-VITS2（`REPLY_TTS_PROVIDER=sbv2`）

- リポジトリのルートで `python server_fastapi.py` を起動します（設定ファイルを相対パスで読むため）
- `config.yml` の `server.port` を **5055** にします（macOS は AirPlay レシーバーが :5000 を使用）。`config.yml` の書き間違いがあると黙って既定値（5000）に戻るので、起動ログのポートを確認してください
- サーバーは認証なしで `0.0.0.0` に待ち受けます。**ファイアウォールで外部から遮断**してください。`server.origins` は `[]` にします
- `/tools/get_audio` は任意の .wav を読めるルートです。外部に出さないでください
- 読み上げた本文が INFO ログに残ります。ログの保管に注意してください
- 1回の入力は100文字まで（長いチャンクはこちらで分割）。改行は送りません
- モデルは最初の合成時に読み込まれるため warm-up を行います。Mac では CPU のみで動きます
- AGPL です。改変せずに別プロセスとして動かしてください
- クレジット：amitaro / koharune のモデルは**画面と配信説明の両方**に表記が必要です（`SBV2_CREDIT` が空だと試聴が `CREDIT_REQUIRED`）。JVNV 由来のモデルは CC BY-SA。既定表記は「Host: Style-Bert-VITS2」

### Supertonic 3（`REPLY_TTS_PROVIDER=supertonic`）

- 上流リポジトリはアーカイブ済みです。起動方法は [COMMENT_REPLY.md](COMMENT_REPLY.md) のとおり
- 演出経路では speed を .7 以上に制限します（設定値 .5〜.69 は従来経路でだけ有効）。表現タグ（`<laugh>` など）は使いません（`<` `>` は拒否）

### VOICEVOX

変更なし。コメント読み上げ（CommentVoice）は常に VOICEVOX で、演出・反応音・フレーズは使いません。

## 9. 聞き比べベンチマーク（npm run voice:bench）

```sh
npm run voice:bench -- --confirm-local --providers=voicevox,aivisspeech,sbv2 --runs=2
npm run voice:bench -- --confirm-local --directed --pid=aivisspeech:1234 --seed=7
npm run voice:bench -- summarize --dir=data/voice-bench/<日時>
```

- `config/voice-benchmark.json` の40文（通常8／感情：うれしい・驚き・照れ・真面目 各4／ライブ：短い反応・質問・ゲーム中の速い反応・長文 各4）を、ループバックのエンジンだけで同じ文ずつ合成します。停止中のエンジンは飛ばします。Jev・LLM は呼ばず、TTS 上限も消費しません
- 計測：TTFA（最初のパートまで）、合計時間、音声長、RTF、呼び出し数、エラー、コールドスタート、CPU / RSS（250 msごと）、GPU（`--gpu=nvidia` のときだけ）
- 出力 `data/voice-bench/<日時>/`：`audio/`、`consistency/`（一貫性テストの音声）、`consistency.csv`、`listening.html`（スクリプトなし・エンジン名なしの聞き比べページ）、`sheet.csv`（採点表）、`key.json`（ラベルと声の対応。採点が終わるまで開かない）、`results.json`
- 採点：`sheet.csv` に naturalness（自然さ）/ character（キャラクター性）/ emotion（感情表現）/ pronunciation（日本語発音）/ listenability（聞き疲れしない）を1〜5、`two_hours` に「この声で2時間配信を聞きたいか」を Y/N、アクセント・読み誤り数を記入し、`summarize` で集計
- **Voice Consistency Test**：`config/voice-benchmark.json` の `consistency`（通常 → 驚き（gasp）→ 喜び（やったー！）→ 笑い → 通常）を、演出あり・`data/voice` の反応音と事前生成フレーズ込みで**1本の音声**にします。`consistency.csv` の `identity_breaks` に「途中で別人に聞こえた瞬間」の数を記入します。反応音やフレーズがライブラリに無い声は、その旨をログに出します（先に `npm run voice:library` で用意すると完全なテストになります）
- `PICK_RULE`：40文字以下の文の TTFA p95 ≤ 1500 ms、RTF p95 ≤ .5、エラー0、コールドスタート ≤ 20 s、**一貫性テストの別人判定0件（未記入も不可）**を満たす候補のうち、「2時間聞きたい：Y」の割合が最も高いもの。同率なら5項目の平均、さらに同点ならアクセント誤りが少ない方
- ベンチマークは推薦だけです。**声を決めるのは運営者**で、`REPLY_TTS_PROVIDER` などを変えたら実試聴をやり直してください。ライセンス・クレジットの義務は採点に含まれないので別途確認してください

### Gemini 3.8 Flash TTS / Flash-Lite TTS（`REPLY_TTS_PROVIDER=gemini-tts` / `gemini-lite-tts`、クラウド・有料）

「途中で別の声に切り替える高価な枠」ではなく、**番組全体の唯一の声**として選べるクラウド音声です（ローカル勢と同じ扱いで、失敗時も別の声へは切り替えず保留）。

- API：`generateContent`（`https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`、固定。URLは設定できない）。キーは会話モデル用の `GEMINI_API_KEY` をヘッダーで送信。出力は 24 kHz / モノラル / 16bit の WAV
- 設定：`GEMINI_TTS_VOICE`（プリセット名、既定 Kore）、`GEMINI_TTS_STYLE`（キャラクターの基本の話し方。英語推奨・200字以内）、`GEMINI_TTS_MAX_USD`（このサーバー起動中の上限額、既定 $3。到達したら発話を保留）
- 演技：Jevの reaction → 声の系統・強さ・速さを `speech_metadata.style` の**短い演技指示**に変換。通常 `casual, friendly`／集中（think）`quietly focused`／驚き `briefly startled, then relieved`／喜び `bright and pleased`／照れ `slightly shy, with a small smile`／困り `mildly disappointed, conversational`（強さ・速さは `subtle`・`speaking slowly` 等を後ろに付ける）。**声の人物像は Voice Design の `voice_` ID が持つ**ので、`voice_` の声には `GEMINI_TTS_STYLE`（人物設定）を送らない。プリセット声（Kore 等）のときだけ先頭に付ける。`HOST_STYLE_MAP` の文字列で系統ごとの表現を上書き可
- キャッシュの同一性：エンジン（モデル）＋声（Voice ID、プリセット声なら人物設定も）＋解決した演技＋本文。音声の後処理を変えたら `src/voice-router.mjs` の `AUDIO_PROCESSING_VERSION` を上げる（1＝現行。既存の VOICEVOX 句キャッシュの鍵は変わらない）
- 無料枠：Gemini の Free Tier は1モデル1日10リクエスト。上限は SSE の中の error イベント（HTTP 200）で届くこともあり、1日の上限は `TTS_BUDGET`（再試行しない）、分単位の制限は一時的な 429 として扱う。30分の配信は無料枠では足りない
- 予算とラウンド：クラウドの声では番組開始時に締めの一言の費用（$0.005）を `CloudSpend.hold('closing')` で先に確保する。NOA BLOCKS は次のラウンドの前に、残額（日・月の小さい方から、実行中リクエストの予約と締めの確保分を引いたもの、`CloudSpend.remaining()`）が1ラウンド分（$0.03、目安であって保証ではない）あるか確かめ、なければ始めずに締める。締めは確保分を使って同じ声で言う。確保できなかったうえ残額も足りなければ、新しい締めの音声は要求せずに終える。別の声へ切り替えて続けることはしない。1日25分の新規音声の出力分だけで Flash-Lite 約 $0.225（入力・作り直しは別）。上限 $0.23 は「25分喋れる保証」ではなく、予算を優先して喋る時間が短くなってよい設定。上限は自動で増やさない。2027年から単価は倍の予定
- 反応音：録音クリップが無いクラスは、**同じ声・同じリクエスト内の音声タグ**で出します（gasp→`<gasp>`、laugh_small→`<chuckle>`、laugh_big→`<laugh>`、breath_in→`<breath>`、breath_out→`<exhales>`、sigh→`<sigh>`）。タグはコードが許可リストから承認済みテキストの先頭か末尾に1つだけ付け、LLMの文章に `<` `>` があれば従来どおり拒否します。タグは発話音声の一部になるため、公開時に外せず、反応音の除外枠ではなく発話の長さとして数えます
- 実試聴：7系統×2強度のスタイル見本と、使われうる音声タグをすべて表現リールで聴きます（有料、1回あたり数円）
- burn-in：クラウドには不要なので行いません
- 料金（2026年12月31日まで、25 audio tokens/秒）：Flash 音声出力 $9/1M → 発話1時間 約$0.81、Flash-Lite $6/1M → 約$0.54。**2027年1月1日から倍額**。配信時間ではなく実際に話した時間で課金されます。Studio の VOICE カードに推定額（返ってきた音声長から算出）を表示します
- 注意：無料枠では入力が Google の製品改善に使われます。Voice Replication（声の複製）は同意確認の仕組みが必要なため未対応です
- ストリーミング（既定。`GEMINI_TTS_STREAM=false` で無効）：Interactions API（`POST /v1beta/interactions`, `stream: true`）で 24 kHz / 16bit の生PCMを受け取り、最初の音声が届いた時点で公開し、ステージは約0.3秒ためてから順に再生します（`/audio/<id>.pcm`、`public/pcm-player.mjs`）。実測（2026-09-27、Flash-Lite）：先頭音声 p50 1.2秒、生成完了 p50 5.1秒。リハーサルは試聴のため全体WAVのまま。ストリーミング経路では反応音ライブラリとフレーズキャッシュは使わず、反応音は同じ声の音声タグで出します
- Voice Design：`npm run voice:design -- --confirm` で説明文からオリジナルの声を作成し、`data/voice-design/<id>.wav` に試聴用サンプルを保存します。`--apply` で `GEMINI_TTS_VOICE=voice_...` を保存（実試聴のやり直しが必要）。実在の人物や既存キャラクターの声の複製はしません
- 費用の上限：生成した音声（再生されなかった先読み・中断分も含む）を `data/cloud-spend.json` に日別・月別で記録し、送信前に見込み額を予約します。1日の上限 `GEMINI_TTS_MAX_USD`（既定$3）、1か月の上限 `GEMINI_TTS_MAX_USD_MONTH`（既定$10）。再起動しても消えません
- 比較：`npm run voice:bench -- --confirm-local --allow-cloud --providers=voicevox,aivisspeech,sbv2,gemini-tts,gemini-lite-tts`。クラウドは `--allow-cloud` と明示指定の両方が無いと1リクエストも送りません。実行前に概算上限額、実行後に推定額を表示します。フレーズの事前生成も同様に `npm run voice:library -- prerender --confirm-local --allow-cloud`

## 10. PREMIUM 枠（未実装の将来契約）

現在は `router.premium = null`、状態は常に `disabled` で、設定キー・秘密・コード経路はありません。将来追加する場合の条件：
- `SECRETS` に専用キー、使用量台帳に専用の種類、checkFingerprint に項目を追加
- 実試聴（表現リールを含む）とクレジット表記を必須にする
- ターン単位でだけ使い、全体に占める割合に上限を設ける
- **フォールバックとしては使わない**。1つの発話の途中で声を混ぜない
