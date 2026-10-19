# 別の Mac（Mac mini など）へ移して配信する

いま使っている Mac の Studio を、別の Mac で動かして配信するまでの手順です。準備するものを先に全部並べ、そのあとに順番どおりの手順を書きます。初回のセットアップそのものの詳しい説明は [SETUP.md](SETUP.md) と [QUICKSTART.md](QUICKSTART.md) にあり、ここでは「移すときに必要なこと」だけを扱います。

> 秘密情報（`.env`、`data/`）は GitHub に入っていません。新しい Mac へは自分で直接コピーし、GitHub・チャット・AI には渡さないでください。

---

## 1. 準備するもの（チェックリスト）

### 機材

| もの | 必須か | メモ |
|---|---|---|
| 配信用の Mac（Mac mini など） | 必須 | macOS。配信中は OBS・声・会話モデルが同時に動くので、メモリは多いほど安定します。16GB なら下の「メモリが 16GB の場合」を参照 |
| 配信用のネット回線 | 必須 | できれば有線 LAN |
| HDMI キャプチャ機器 | **スマブラなど Switch の番組を配信する場合だけ** | 新しい Mac に挿します。下の「Switch の映像を2台で使う場合」も参照 |
| HDMI 分配器と2台目のキャプチャ | 開発用の Mac でも同時に Switch 映像を使う場合だけ | Switch → 分配器 → 各 Mac のキャプチャ |

### ソフト（新しい Mac に入れる）

| ソフト | 必須か | 既定の接続先 | メモ |
|---|---|---|---|
| Node.js 22.12 以降 | 必須 | — | npm の追加パッケージは不要 |
| OBS Studio（WebSocket が使える版） | 配信するなら必須 | `ws://127.0.0.1:4455` | ツール → WebSocket サーバー設定でパスワードを決める |
| 会話モデル：Ollama | どれか1つ必須 | `http://127.0.0.1:11434` | 旧 Mac と同じモデルを `ollama pull` で入れる（自動ではダウンロードしません）。Gemini などを使うなら不要 |
| VOICEVOX Engine | 必須（コメント読み上げは常に VOICEVOX） | `http://127.0.0.1:50021` | |
| AivisSpeech Engine | ノアの声に使っているなら必須 | `http://127.0.0.1:10101` | 現在のノアの声は「コハク / ノーマル」。同じモデルを AivisSpeech 側で入れる |
| Style-Bert-VITS2 / Supertonic / VTube Studio | 使っている場合だけ | :5055 / :7788 / :8001 | 使っていなければ不要 |

### アカウント・鍵（値はメモせず、新しい Mac の設定画面で入れ直すか、`data/` ごと移す）

- Jev（TypeSafe）の API キー（`TYPESAFE_API_KEY`）。ライブには必須です。
- YouTube Data API キー（`YOUTUBE_API_KEY`）か、OAuth（`YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`、トークンは `data/youtube-oauth.json`）。
- OBS のストリームキー。OBS の設定 → 配信に入れます。AI や Studio には渡しません。
- Gemini などのクラウドを使っていれば、そのキー。

### 旧 Mac から持っていくファイル

| ファイル | 持っていくか | 理由 |
|---|---|---|
| リポジトリ（このフォルダのコード） | GitHub から取得 | `git clone` / `git pull` |
| `.env` | あれば持っていく | 秘密情報を含みます。AirDrop・USB メモリなどで直接 |
| `data/settings.json` | 持っていく（設定画面で入れ直すなら不要） | 設定画面で保存したキー・声・モデルの選択。`.env` より優先されます。平文なので取り扱い注意 |
| `data/youtube-oauth.json` | OAuth を使っているなら | 再認証（`npm run youtube:auth`）でも作り直せます |
| `data/programmes/`、`data/lobby-scenes.json` | 企画を編集していたら | 編集した企画の文章 |
| `data/ads.json` と広告の素材、`data/sponsor.json` | 広告・スポンサー表示を使っていたら | |
| `data/avatar-mode.json`、`data/avatar-wardrobe.json` | 見た目の設定を引き継ぐなら | |
| `data/*records*.json`、`data/usage.json`、`data/cloud-spend.json` | 戦績・使用量の記録を続けるなら | なくても動きます |
| `data/jev-billing-hold.json` | **あれば持っていく** | Jev の支払い保留（HTTP 402）の記録。移さないと、新しい Mac で有料リクエストを再び送ってしまいます |
| `data/obs-owned.json` | **持っていかない** | 旧 Mac の OBS の所有記録。あると新しい Mac で起動を拒否します |
| `data/rehearsal-approval.json` | 持っていかない | 試聴は新しい Mac でやり直します（下の手順 5） |
| `data/events.jsonl`、`data/show-log.jsonl` | 不要 | 旧 Mac の記録 |

迷ったら、`data/` を丸ごとコピーしたあとで `obs-owned.json` と `rehearsal-approval.json` だけを消してください。

---

## 2. 手順

1. **旧 Mac の Studio を止める。** 配信中なら OBS 側で配信停止まで確認します。同じ YouTube 配信枠に2台からつながないためです。
2. **コードを取得する。** 新しい Mac で：
   ```sh
   git clone https://github.com/FORIFOR/Jev_VTuber_Studio.git
   cd Jev_VTuber_Studio
   git checkout release/rc6-voice   # いま使っているブランチ
   ```
3. **秘密情報を置く。** 旧 Mac の `.env` と `data/` を、新しい Mac のこのフォルダへ直接コピーします（上の表のとおり、`data/obs-owned.json` と `data/rehearsal-approval.json` は消す）。
4. **ソフトを起動する。** OBS、Ollama（または使うクラウド）、VOICEVOX、AivisSpeech を起動します。Ollama は旧 Mac と同じモデルを入れておきます。
5. **Studio を起動して、設定ページで確認する。**
   ```sh
   npm run release:check   # テストが通るか（外部サービスは使いません）
   npm start               # または start.command をダブルクリック
   ```
   表示された `Control: http://127.0.0.1:8787/setup#admin=…` を開き、次を行います。
   - 「準備状況」の **いま確認する**。会話モデル・声・Jev キー・OBS・YouTube が ✓ になるまで、各行の「開く」から直します。キーを移さなかった場合は、ここで入れ直します。
   - **実試聴**（03）。声を最後まで聞いて「聞こえた」を押します。これをしないとライブの雑談は始まりません。
   - **OBS に専用シーンを作る**（04）。新しい Mac の OBS に `Jev Studio` などのシーンが作られます。OBS の音声メーターで、声が1回だけ入っているか（二重になっていないか）確かめます。
6. **Switch の番組（スマブラなど）なら映像をつなぐ。** キャプチャ機器を新しい Mac に挿し、`/switch` ページで機器を選んでシーン（`JVS Switch Capture`）を作り、30 秒の試し録画を再生して映像と音を確認します。macOS が OBS にカメラ・画面収録の許可を求めたら許可します。詳しくは [SWITCH_MINECRAFT.md](SWITCH_MINECRAFT.md)。
7. **初回は限定公開で試す。** OBS の配信先・ストリームキー・公開範囲を設定し、YouTube の配信枠の URL を設定ページに入れます。配信の開始は OBS で自分で行うか、`ALLOW_OBS_STREAM=true` にした上で Studio の配信開始ボタンで明示的に確認して行います。限定公開でコメントの読み取り・声・映像を確かめてから公開にします。

---

## 3. メモリが 16GB の場合

見積もり（16GB の実機では未検証）：macOS 3〜4GB、会話モデル 9B 約6〜7GB（4B なら約3.5〜4GB）、声のエンジン 1.5〜3GB、OBS とステージ 1.5〜3GB、Studio 最大約1GB。9B のままだと余裕がほとんどありません。

- 会話モデルを 4B などの小さいものにするか、クラウドの会話モデルにする（変えたら実試聴をやり直す）。
- `.env` に `MEMORY_GUARD=1` と `KEEP_LIVE=1` を入れる。メモリが危なくなっても配信は止めず、話を一時停止して会話モデルを解放し、回復したら再開します（[memory-protection.md](memory-protection.md)）。
- 長時間配信の前に、限定公開で 1〜2 時間通してメモリの余裕を確かめる。

## 4. Switch の映像を2台で使う場合

スマブラの改善（開発用の Mac で Pi のコントローラーを動かし、映像を見て操作するボット）と、別の Mac での配信を同時に行うときの注意です。

- **映像：** キャプチャ機器は1台の Mac にしか挿せません。両方で映像が要るなら、HDMI 分配器で Switch の映像を分け、それぞれの Mac にキャプチャ機器をつなぎます。ネットワークで映像を送る方法もありますが、遅延と負荷が増えます。
- **コントローラー：** Switch につながる Pi は1台です。配信の番組は「配信者が操作する」作りなので、配信中は開発用 Mac のボット（`tools/spar.mjs`）を止めて、入力が混ざらないようにします。
- **ネット：** Pi も有線 LAN にすると、開発用 Mac からの入力の遅れとばらつきが減ります（Wi-Fi では往復平均 23 ms・最大 56 ms を観測）。

---

## 5. 移したあとの確認

- [ ] `npm run release:check` が通る
- [ ] 「準備状況」がすべて ✓（使わないものは －）
- [ ] 実試聴を新しい Mac で行い、「聞こえた」を押した
- [ ] OBS の専用シーンを新しい Mac で作り直し、音声が二重になっていない
- [ ] （Switch の番組なら）試し録画で映像と音を確認した
- [ ] 限定公開でコメントの読み取りを確認した
- [ ] 旧 Mac の Studio と OBS の配信が止まっている
