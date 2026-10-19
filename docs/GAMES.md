# ゲームの追加と差し替え

ゲームは `games/<id>/` のプラグインです。番組（`config/programmes.json`）は `"game": "<id>"` でどのゲームを遊ぶかを指定し、スタジオ本体（`src/`）は特定のゲーム名を持ちません。1つのゲームは次の3つで構成されます。

| 部品 | 置き場所 | 役割 |
|---|---|---|
| 操作役（コントローラー） | 別のプログラム（例：jev-vampire-survivors） | ゲームを起動し、Jevの判断でプレイし、観測した状態をログに書く |
| 実況（ショー） | `games/<id>/show.mjs`（Vampire Survivors は `src/vampire-show.mjs`） | ログの状態から出来事を見つけ、ノアの台詞・実況・質問への答えを作る |
| 定義（マニフェスト） | `games/<id>/game.json` | 操作役の起動方法、ログの場所、OBSで映すウィンドウと音 |

ゲームを替えるときは、番組の `game` を替えるだけです。Jev の審査（`Jev.speech()`・閾値）はどのゲームでも同じで、ゲームごとに緩めることはできません。

### 誰が操作し、どう映すか（`player` と `capture.kind`）

| `game.json` | 値 | 意味 |
|---|---|---|
| `player` | `jev`（既定。`controller` があるとき） | 操作役プログラムを番組と同時に起動し、そのログの観測から実況する |
| | `operator` | 人がコントローラーで遊ぶ。操作役は起動しない。ノアは Studio の「試合の報告」ボタンで押された出来事だけを実況する（ショーの `operatorReport(event)`） |
| `capture.kind` | `window`（既定） | このMacのゲームウィンドウ（`appName`／`windowTitle`／`bundleId`、ScreenCaptureKit） |
| | `switch` | Studio の **Switch接続**（`/switch`）で選んだキャプチャー機器。その `JVS Switch Video`／`JVS Switch Audio` 入力を番組シーンに置くだけで、機器の選択・ミュート・モニタリングは Switch接続側が持つ |

例：`games/smash-ultimate/`（スマブラSP）は `player: "operator"`・`capture.kind: "switch"`。配信者が Switch で遊び、ノアは隣で見ている実況役として話す（`promptRule` でモデルにもそう伝える）。画面の表示は「AIが実況中」で、「AIがプレイ中」とは出ない。

### ゲームの情報表示を隠さない（`stage`）

配信画面の配置（部屋テーマの `side`／`front`／`full`／`frame`／`wide`）は、ゲームによって向き不向きがあります。たとえば `frame` はヴァンサバの「情報表示は上の端、プレイヤーは真ん中」に合わせて下側に字幕やノアを置くので、画面の下に％とストックが並ぶスマブラでは、それを隠してしまいます（2026-10-19）。そこで各ゲームの `game.json` に次を書きます。

| `stage` の項目 | 意味 |
|---|---|
| `layout` | このゲームで使う配置。設定の `ROOM_GAME_LAYOUT` より優先されます（書かなければ設定のまま） |
| `hud` | ゲーム自身の情報表示の場所。ゲーム画面に対する割合 `[x, y, 幅, 高さ]`（0〜1）の配列 |

`test/game-stage-hud.test.mjs` が、各ゲームが選んだ配置の重ねもの（ノアの体、字幕、チャット、広告、目標、操作ログなど）が `hud` にかからないことを確かめます。今の指定は次のとおりです。

- ヴァンサバ：`layout: "frame"`、`hud` は上の端（12%）と真ん中のプレイヤー
- スマブラ：`layout: "wide"`（没入型、2026-10-19：ゲームを 1600×900 で大きく、ノアは右の列・字幕は下の帯でゲームの外）、`hud` は下の帯（22%）と右上の時間

人が遊ぶゲーム（`player: "operator"`）には「ノアの操作」の帯を出しません。

### 配信中のゲーム操作の切り替え（NOA Studio Phase 5、2026-10-19）

AI が操作するゲーム（今はヴァンサバ）は、配信を止めずに人間へ操作を渡し、また AI に戻せます。操作は Studio の「プレイヤー切替」ボタンか F7 で行い、`POST /api/game/player {player}` でも切り替えられます。声（F6）とは別々に切り替えられます。

**操作権の受け渡し**
- 操作権は常にどちらか一方だけが持ちます。
- Studio は `<GAME_DIR>/.local/noa-player-mode.json` に `{mode, epoch, ...}` を書きます。一時ファイルに書いてから名前を変えるので、途中まで書かれたファイルが読まれることはありません。書き込みに失敗したらエラーにして、操作の担当は元のままにします。
- コントローラーは各 `epoch`（受け渡しの通し番号）に、同じフォルダの `noa-player-ack.json` で返事をします。
  - 人間へ渡すとき：入力をすべて離して（`release`）から返事をします。
  - AI へ戻すとき：新しいゲームの状況を読んでから返事をします。この返事には、AI がその時点でいる画面（`phase`）が入ります。
- Studio は返事を最大1.5秒待ちます。返事が来なくても切り替えはそのまま有効にし、警告を出します。コントローラーは次のループでキーを離すからです。
- AI の入力（移動・行動）は、送る直前に毎回モードを確認します。そのため、切り替えの前に計算していた入力が、切り替えたあとに出ることはありません。

**AI に戻したとき**
- 返事の `phase` がメニューなどの場合、AI はその画面が終わるのを待ちます。
- Studio には「levelupの画面の終わり待ち」のように表示します。

**人間がプレイしている間**
- コントローラーは判断をしませんが、ゲームの状況を1秒ごとに記録（`event: "observe"`）に書きます。そのため、ノアは実際のプレイを見て実況できます。
- 配信画面のラベルは「AIが実況中」になります。
- 実況の指示も「中の人が操作していて、ノアは見ながら実況している」に切り替わるので、ノアが「自分が操作している」とは言いません。

スマブラは AI の入力が配線されていないので、この切り替えの対象外です。将来配線する場合は、この受け渡しの仕組みに乗せ、`stop()` の NEUTRAL を「入力をすべて離す」処理として使います。

### Studio の設定ページ（`/setup`「ゲーム配信」）で変えられるもの

選んだ企画のゲームに合わせて、ゲーム音のオン／オフ（`GAME_AUDIO`）と大きさ（`GAME_AUDIO_DB`、空欄ならマニフェストの `audioVolumeDb`）、`jev` が操作するゲームなら操作役のフォルダ（`GAME_DIR`）・実行ファイル（`GAME_EXECUTABLE`）・費用上限（`GAME_MAX_COST_USD`）、BGM（`OBS_BGM_FILE`／`OBS_BGM_VOLUME_DB`）。`switch` のゲームは機器の選択・プレビュー・テスト録画を Switch接続ページで行い、未設定のまま番組を準備すると「Switch接続で機器を選んでください」と断られます。

## 新しいゲームを足す手順

1. `games/_template/` を `games/<id>/` にコピーする（`_` で始まるフォルダはゲームとして扱わない）。
2. `game.json` の `id`（フォルダ名と同じ）、`title`、`controller`、`capture`、`stage`（使う配置と、ゲーム自身の情報表示の場所。上の「ゲームの情報表示を隠さない」）を書く。
3. `show.mjs` に、そのゲームの出来事（`POLICY`）と台詞（`LINES`）、`ingest()` での検出を書く。
4. `config/programmes.json` に番組を足し、`"game": "<id>"` を指定する（雑談から始める `show.lobbyMinutes` などは Vampire Survivors の `noa-vampire` を参考に）。
5. 設定（`data/settings.json`）で操作役の場所を指定する：`GAME_DIR`（操作役のフォルダ）、必要なら `GAME_LOG_DIR`、`GAME_AUDIO=true`（ゲーム音を配信に入れる）、`GAME_MAX_COST_USD`、`GAME_EXECUTABLE`（`command` の先頭を置き換える。例：仮想環境の python）。旧名 `VAMPIRE_REPO`／`VAMPIRE_RUNS_DIR`／`VAMPIRE_GAME_AUDIO`／`VAMPIRE_PYTHON`／`VAMPIRE_MAX_COST_USD` も使えます。
6. 確認：`npm test`（`test/games.test.mjs` が架空のゲームで同じ手順を検証している）→ 台詞をリハーサルで Jev に通す → 必要なときだけ本番相当の試験を1回。

## 操作役（コントローラー）がすること

言語は自由です。スタジオとの約束は次のとおりです。

- **起動**：`controller.command` と `args` で起動される。スタジオは作業フォルダを `GAME_DIR` にし、最小限の環境変数（PATH・HOME など）だけを渡す。キーは操作役が自分の `.env` から読む。
- **上限**：`args` に書いた引数名で `session`（名前）、`seconds`（プレイ時間）、`maxCalls`、`maxCost`（Jev の費用上限）を受け取り、それを守る。書かなかった値は渡されない。
- **ログ**：1回のプレイごとに `<logDir>/<run>/<logFile>` を作り、状態を1行1JSONで追記する：`{"state": {...}}`。新しい run フォルダ＝次のラウンド。
- **選択の実況**（任意）：メニューで選ぶゲームは、`choicePhases` の場面で `{"event": "choice_planned", "phase": ..., "attempt": ..., "choice": i, "candidates": [...]}` を押す前に書くと、ノアが選んだ理由と一緒に話せる（ショーの `ingest` に `pick` として届く）。
- **進行状況**：標準出力の行を `progress` の正規表現（`starting`／`playing`／`restarting`／`failed`（1つ目のグループが理由）／`slow`）で読む。生の出力はスタジオ画面に出ず、`data/game-runner.log` にだけ残る。
- **停止**：SIGINT（Ctrl+C）でゲームを一時停止して終了する。20秒で終わらなければ SIGTERM。

## 実況（ショー）がすること

`show.mjs` は `createShow(showConfig, deps)` を export します。`src/external-game-show.mjs` の `ExternalGameShow` を継承すると、雑談 → 前置き（「ではそろそろ、ゲームを始めようかな。」）→ ゲーム紹介 → プレイ → 結果 → 次のプレイ、の流れ・台詞の優先度・古い出来事の破棄・放送直前の再確認が共通で付きます。ゲームごとに書くのは次です。

- コンストラクタの定義：`title`、`what`（一文の説明）、`statusKey`（画面とスタジオに状態を送るイベント名）、`startLine`／`waitLine`（ゲーム開始の告知、各2文まで）、`policy`、`lines`、`recordsFile`（自己ベストの保存先、`data/` 配下）。
- `ingest({ runId, state, pick })`：最初に `this.admit(runId, state)`、変化を見つけたら `this.push(type, facts)`、ゲームオーバーで `this.finish('game_over')`。
- 任意：`commentary()`（何も起きていない時の実況）、`answer(text)`（視聴者の質問に観測値で答える）、`closing()`（今夜のまとめ）、`finishRound()`（結果と自己ベスト）、`stillTrue(e)`、`numbers()`、`observation()`、`promptRule(utterance)`（モデルに伝えるこのゲームの注意）、`statusExtra()`。

台詞の数字や名前は観測値だけから作り、モデルに推測させません。定型台詞はリハーサル（本物の Jev）で審査を通ることを確認してから使います。通らないときは台詞や観測の渡し方を直し、閾値は変えません。

## 画面と OBS

- 配信画面は `#layout=game`：ゲーム枠（1120×630、左上 48,120）と「AIがゲームをプレイ中」、回数・自己ベスト（ショーの `status()` の `run`／`personalBest`）。雑談中（`phase: 'lobby'`）はノアが中央。
- OBS はゲームごとのシーン `<OBS_SCENE> - <title>` を作り、`<title> Window`（`capture.appName`／`windowTitle` のウィンドウだけ。似た名前のブラウザのタブなどは映さない）、`<title> Audio`（`capture.bundleId` のアプリ音、`GAME_AUDIO=true` のとき）、BGM を置く。タイトルバーは `cropTopPx` で切る。
- `capture.kind: "switch"` のゲームは、同じシーンのゲーム枠に `JVS Switch Video` を置き、`GAME_AUDIO=true` なら `JVS Switch Audio` も置く（音量だけ `GAME_AUDIO_DB`／`audioVolumeDb` に合わせる）。入力の作成・機器の変更・ミュートはしないので、Switch接続ページの所有権チェックはそのまま通る（番組シーンだけが共有を許される）。雑談中（lobby）は映像・音のアイテムを非表示にする。
