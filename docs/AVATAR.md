# アバター演技と画面の分離

## 画面の役割

| 画面 | 表示するもの |
|---|---|
| `/stage`（視聴者・OBS） | アバター、字幕、ゲーム（ゲーム番組のときだけ）、AIが拾ったコメント（数秒）、音声クレジット |
| `/`（Studio・運営のみ） | AI STATE / REACTION / COMMENT QUEUE / PERFORMANCE / GAME BRAIN / PROGRAMME・AVATAR / EVENTS |

番組の進行、DEMO表示、自動運転状態、Jev判定、レイテンシは視聴者画面から外しました。Studio は管理キーで `GET /api/monitor` を1秒ごとに取得します。コメント本文やタイミングを含むため、この内容は視聴者用のイベントストリーム（`/events`）には流しません。

音声クレジット（「VOICEVOX:〇〇」など）は声のライセンス条件なので、視聴者画面の右下に小さく残しています。YouTube の投稿者名はプライバシー設計上ハッシュ化しているため、拾ったコメントは「コメント」という見出しだけで表示します。

## 演技の流れ

```
Jev.speech()  ── reaction: "shock" などプリセット名だけを選ぶ（数値は決めない）
      │
Effects.reaction()  ── laugh / shock / excited は6秒に1回まで。それ以外は落ち着いた代替
      │
engine: pending.reaction / Affect（happy・energy・focus がゆっくり戻る気分）
      │  speech / speech_started イベント
      ▼
AvatarController（public/avatar-rig.mjs）
  idle  : まばたき・呼吸・首のゆれ・視線のさまよい（Jevを呼ばずローカルで常時）
  listen: ナレーターがコメントを読む間、コメントの方へ顔と視線を向ける
  reflex: 声の前に反射（目を見開く・のけぞる）。声は lead ミリ秒（最大400ms）遅らせる
  即時反射: Jevがコメントを採用した瞬間（listen）や星を取った瞬間（excited）に、言葉も音も出さず表情だけ先に動く。
            LLM・Jev・TTSの待ち時間を埋めるためのもので、誰かが話している間は出さない（1.5秒に1回まで）
  speak : 表情を保ったまま、音声の音量で口パク
  after : 余韻として表情を保ち、その後 idle へ戻る
      │  Live2D Cubism 標準パラメータ（ParamAngleX, ParamEyeLOpen, ParamMouthForm …）
      ├─► 内蔵SVGアバター（stage.mjs の draw）
      └─► POST /api/renderer/avatar（音声リースを持つ画面だけ、約20fps）
              └─► VTube Studio InjectParameterDataRequest → Live2Dモデル
```

デモモードは Jev を呼ばず、発話文のキーワードでプリセットを選びます（`demoReaction`）。

### 声の演技との同期（SPEECH_DIRECTION が off 以外）

声の演技（[VOICE.md](VOICE.md)）は同じプリセット名を使い、公開時に Effects のクールダウンを通った後の reaction と強さが、表情・反応音・カメラをまとめて決めます。

- **強さ**：`intensity`（low / mid / high）は声とアバターで共通です。アバターは `INTENSITY_GAIN`（low .7 / mid 1 / high 1.25、`public/voice-acting.mjs`）を `AvatarController.react(name, now, gain)` に渡し、表情・動き・反射の大きさを変えます（.5〜1.3 に制限）。Effects が大きい演技を代替へ下げたときは強さも high → mid に下げます。low のときは顔寄りのズームをしません
- **pre 反応音と leadMs = 0**：パート0の前に反応音（gasp・laugh_big・breath_in・hmm）を残した場合、サーバーは `leadMs: 0` を送り、ステージは `voiceLead()` で反射の待ち時間を0にします。WAV の先頭が反応音なので、息をのむ音・反射・ズーム・口の動きが同じフレームで始まります。反応音を外したときは従来どおり反射の lead（最大400ms）だけ声を遅らせます
- **パート途中のビート**：チャンクごとに reaction が変わる場合、`speech` イベントの `beats`（`atMs` と reaction、1パート最大4つ）に従って、WAV の再生開始からの時刻で表情を切り替えます。ビートは落ち着いたプリセットだけで、大きい演技（laugh / shock / excited）は代替に置き換え、listen は使いません
- **マウス窓**：`hmm`（口を閉じたハミング）の区間は `mouth` 窓（`startMs` / `endMs` / `scale: .2`）で口パクの開きを抑えます。1パート最大2窓
- **VTube Studio**：ビート・強さ・マウス窓もすべて `AvatarController` の出力に反映されるため、音声リースを持つ `/stage` が送るフレームで VTube Studio のモデルも同じ演技をします

## プリセット

| 名前 | 表情 | 動き | 補足 |
|---|---|---|---|
| neutral | — | — | |
| nod | 少し笑顔 | うなずき2回 | |
| happy | 笑顔・目を細める・頬 | 首を少し傾ける | |
| laugh | 目を閉じた笑顔 | 体をゆらす | 大きい演技（代替: happy） |
| surprised | 目を見開く・眉を上げる | 少しのけぞる | 声の前に反射 |
| shock | 目を見開く・口が開く | 大きくのけぞる・顔寄り | 大きい演技（代替: surprised） |
| embarrassed | 頬を赤く・視線をそらす | 顔をそむけて傾ける | |
| thinking | 視線を上へ・片眉 | 首をかしげる | |
| troubled | 困り眉・への字 | 首を傾ける | |
| excited | 笑顔・目を見開く | 跳ねる・顔寄り | 大きい演技（代替: happy） |
| listen | コメント方向を見る | 顔を向ける | ローカル専用。Jevには提示しない |

プリセットの中身（どのパラメータをどれだけ動かすか）はすべて `public/avatar-rig.mjs` のコードです。

## ノアの2D / 3Dアバター切替

管理画面で従来の2DとNoa 4.86のVRMを選べます。未保存時は2D、保存済みの選択は再起動後も維持します。既存の演技・音声制御を3Dへ接続し、許可済みVRMAと髪の物理を使用します。[切り替え・構成・再ビルド](VRM.md)、[評価と未確認範囲](VRM_EVALUATION.md)を参照してください。

## ノアのパーツ画像アバター（互換モード）

`/stage?avatar=noa` は `public/models/noa/` の19枚のパーツ画像（`model.json` に位置・種類・支点）をcanvasに重ねて描きます（`public/layer-avatar.mjs`）。動かしているのは SVG・VTube Studio と同じ `AvatarController` のパラメーターです。読み込みに失敗したら組み込みSVGに戻ります。`?avatar=builtin` で SVG、`?avatar=external` で非表示（VTube Studio を別ソースで重ねる場合）。

- 対応：まばたき（閉じ目パーツへ切替）、視線（白目の中だけ黒目が動く）、口パク（開き口パーツ、音量連動）、笑い目（閉じ目の弧）、頬の赤み、眉の上下・角度、首・体の小さな傾き、呼吸、横髪のばね揺れ。
- 表情の見分け：眉の大半が前髪に隠れるため、眉だけに頼らず口の形で表す。「びっくり」＝目を見開く＋小さな「o」の口（話している間は丸めの口）、「困り顔」＝波形で口角の下がった口＋下向きの視線＋首の傾き。どちらもパラメーターだけから判定（`expressionWeights`）するので、SVG・VTube Studio と同じ演技値で動く。
- 限界：パーツを画像ごと動かすだけで、メッシュ変形はしない。首の回転は現実のプリセット範囲（ロール±12・ヨー±15程度）で継ぎ目が出ないことを確認済み。パラメーター上限（±30）まで振ると、体側に描かれた髪と頭側の髪の境目が段になる。
- 素材：`Noa_Live2D_Prototype_v0.1` の `Source/layers/*.png`（画像のみ）から `scripts/build-noa-layers.py` で生成（Pillow が必要）。首下の明るい肌パッチの塗り直し、左髪の白いにじみ除去、フード左上の四角い切り口を丸い肩に、右側の直線の切り口をぼかし、既存の口から「o」口と波形口を作成、不透明範囲で切り抜き（1.7MB）。切り抜き後も元キャンバス上の位置・重なり順は同じ（見た目の差は1画素・最大4/255）。同梱の `.moc3` と書き出し・表示コード（GPL-3.0）はこのリポジトリに入れていない。`.moc3` は公式 Cubism Core / VTube Studio で未検証。

## 2D描画 v4

`public/noa-avatar-v4.mjs`（デザイン引き継ぎ「Noa avatar v4」、`LayerAvatar` を継承）。パラメーター・パーツ画像・VTube Studio 出力は v3 と同じで、見た目と動きだけを強化する。

- 顔の向き：頭のパーツを別キャンバスにまとめ、9×9 の三角形メッシュで円柱状に変形（首元は固定、変形前の頭を下に敷いて継ぎ目を隠す）。
- まぶた：目を消さずに上まぶた（肌色）が下りる。笑顔は下まぶたが上がる。閉じ目の弧の下は肌色でならす。
- 口の形（a/i/u/e/o/ん）：ステージが話している台詞のかなから一行ぶんの母音列を作り、実際に聞こえ始めてからの経過時間で進める（漢字は文字ごとに固定の母音で、ちらつかない）。口の開きは従来どおり実際の音量。コメント読み上げ役では口を動かさない。
- 横髪のばね揺れ、反応に合わせた弾み（驚き・のけぞり・はしゃぐ・笑う）と光の変化、髪留めのきらめき、ヘッドホンのランプ（話している間は音量で明るく）。
- 光：夜の青み＋**窓（月）側＝画面左が寒色、ランプ側＝右が暖色**（引き継ぎの原案は左右が逆だったため、このステージの部屋に合わせて反転）。輪郭光も同じ向き。
- 選択：`/stage?renderer=v3`（従来の軽い描画）、`?rim=off`（輪郭光なし）。配信 PC で 60fps が出ないときに使う。この Mac のヘッドレス Chrome では v4・v3 とも 60fps（OBS 環境では未計測）。
- ステージの指定は `#token=…&layout=…` と `?fx=off` 形式のどちらでも読む（同じキーは `#` 側が優先）。`token` は `#` 側だけ（サーバーへ送らない）。

## 演出エフェクト（ノア専用）

表情・身体（既存の reaction）に、光・線・テロップ・任意の効果音を一組で重ねる。判断は `public/effect-director.mjs`（純粋関数、テスト可能）、描画は `public/effects-layer.mjs`。追加のAI呼び出しはない。`?fx=off` で無効（比較用）。

| プリセット | 出す条件 | 画面 |
|---|---|---|
| 喜び joy | ゲームの実イベント（2ライン以上の消去・危険からの回復）への反応、または強い excited。普通のお礼は顔だけ | 顔の周りの小さな星、台詞の一節を弾ませる |
| 驚き surprise | surprised / shock | ノアの周囲だけの集中線、「待って！」など |
| 照れ shy | embarrassed | 暖色の小さな光、控えめな文字 |
| 困り trouble | troubled かつゲームの行（視聴者の相談には出さない） | 小さな汗と縦線 |
| 笑い laugh | laugh | 顔の横の波線 |
| 記録 record | 実際に playing→results を見たときの初記録・自己ベスト更新（再接続では再生しない） | 盤面の枠が光り、紙吹雪。やわらかいチャイム（音声担当の画面だけ） |

- 通常・集中・考え中・うなずき・コメント読み上げ役には出さない。毎発話に何か出す仕組みはない。
- 発話の演出は、実際に再生が始まった `speech_started` で出す（TTS 失敗・未再生なら出ない）。単語ごとの時刻はないので、音声パートの開始に合わせる。テロップは承認済みの台詞の**句をまるごと**（否定を含めて）使い、条件節（〜たら、〜ば、）の後の句や10字を超える句は出さない。
- 同じ出来事は一度、主役は同時に一つ（優先度の高い驚き・記録だけが割り込む）、同じプリセットは6秒空ける、表示は最大3秒。中断・停止・新しいセッション・新しいラウンドで消す。演出の失敗はゲームや音声を止めない。
- 声は加工しない（ピッチ・歪み・別人の笑い声は使わない）。
- 設計は ponyo877/jev-telop-live の考え方（演出を束で選ぶ、出しすぎをコードで抑える）を参考にした独立実装。同リポジトリはライセンス表記が確認できないため、コード・素材は一切コピーしていない。

## VTube Studio（Live2Dモデル）をつなぐ

Live2D モデルの描画は VTube Studio が担当します。このリポジトリには Cubism SDK やモデルを同梱しません（ライセンスと依存ゼロ方針のため）。

1. `.env` に `VTS_ENABLED=true`（必要なら `VTS_URL`）を設定して再起動
2. VTube Studio で API を有効化し、Studio の「Live2D / VTube Studioを接続」を押してプラグインを許可
3. 接続時に次のカスタム入力を作成します。VTube Studio のモデル設定で、右側の Live2D パラメータへ一度だけ割り当ててください

| VTS入力 | 割り当て先 |
|---|---|
| FaceAngleX/Y/Z, EyeOpenLeft/Right, EyeLeftX/Y, EyeRightX/Y, BrowLeftY/RightY, MouthOpen, MouthSmile | 既定のトラッキング設定のまま |
| JevCheek | ParamCheek |
| JevEyeSmile | ParamEyeLSmile / ParamEyeRSmile |
| JevBodyAngleX / Y / Z | ParamBodyAngleX / Y / Z |
| JevBrowAngle | ParamBrowLAngle / ParamBrowRAngle |

4. OBS では `/stage#token=…&avatar=external` を使うと内蔵SVGを隠し、VTube Studio のキャプチャを重ねられます。

注意:
- 左右の向き（ParamAngleX の正負）はモデルによって逆のことがあります。VTube Studio 側の反転設定で合わせてください。
- 作成できなかったカスタム入力は送信しません（未作成のIDを送るとリクエスト全体が失敗するため）。
- フレームは音声リースを持つ `/stage` だけが送ります。ステージを開いていないときは VTube Studio 自身のトラッキングに戻ります。
- 実機の VTube Studio との接続はこの変更では確認していません（テストは偽の WebSocket で送信内容のみ検証）。
